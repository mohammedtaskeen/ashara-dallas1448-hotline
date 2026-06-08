/**
 * Ashara Community Medical Hotline
 * Twilio + Google Sheets call routing server
 *
 * Call flow:
 * Incoming → Primary Doctor (press 1) → Backup Doctor (press 1) → Coordinator → SMS alert
 *
 * Disconnect recovery:
 * If primary drops call (< MIN_CALL_DURATION seconds) → call backup
 * If backup drops call (< MIN_CALL_DURATION seconds) → call coordinator
 */

require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const { getOnCallSchedule, getDebugInfo } = require("./schedule");
const { logCall } = require("./callLog");
const { sendMissedCallSMS } = require("./notifications");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const VoiceResponse = twilio.twiml.VoiceResponse;

// ─── Config ────────────────────────────────────────────────────────────────
const RING_TIMEOUT_SECONDS = parseInt(process.env.RING_TIMEOUT_SECONDS || "20");
const BASE_URL = process.env.BASE_URL || "";
// Calls shorter than this (seconds) are treated as accidental disconnects
const MIN_CALL_DURATION = parseInt(process.env.MIN_CALL_DURATION || "10");

const DISCLAIMER =
  process.env.DISCLAIMER_MESSAGE ||
  "For medical emergencies, please call 9 1 1. " +
    "This hotline is for non-emergency medical guidance only. " +
    "Please hold while we connect you to the on-call doctor.";

function log(label, data) {
  console.log(`[${new Date().toISOString()}] [${label}]`, JSON.stringify(data, null, 2));
}

// ─── In-memory call state ───────────────────────────────────────────────────
// Tracks which leg a call is on so the status callback knows where to route next
// { [callSid]: { leg: 'primary'|'backup'|'coordinator', caller: string } }
const callState = {};

// ─── Incoming Call ──────────────────────────────────────────────────────────
app.post("/voice/incoming", async (req, res) => {
  const twiml = new VoiceResponse();
  const callerNumber = req.body.From || "Unknown";
  const callSid = req.body.CallSid;

  log("INCOMING", { callerNumber, callSid });

  let schedule;
  try {
    schedule = await getOnCallSchedule();
    log("SCHEDULE", schedule || "null — no active schedule");
  } catch (err) {
    log("SCHEDULE_ERROR", { message: err.message });
    twiml.say(
      { voice: "Polly.Joanna" },
      "We're sorry, the medical hotline is temporarily unavailable. " +
        "For medical emergencies, please call 9 1 1."
    );
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  if (!schedule || !schedule.primaryPhone) {
    log("ROUTING", "No schedule — sending SMS alert and hanging up");
    twiml.say(
      { voice: "Polly.Joanna" },
      "We're sorry, there are no doctors currently scheduled. " +
        "Someone will follow up with you shortly. " +
        "If this is an emergency, please call 9 1 1. Goodbye."
    );
    twiml.hangup();
    setImmediate(async () => {
      await sendMissedCallSMS({ caller: callerNumber, reason: "no_schedule", schedule: null });
      await logCall({ caller: callerNumber, callSid, timestamp: new Date().toISOString(), outcome: "missed", reason: "no_schedule" });
    });
    return res.type("text/xml").send(twiml.toString());
  }

  // Track this call — starting on primary leg
  callState[callSid] = { leg: "primary", caller: callerNumber };
  log("CALL_STATE", { callSid, state: callState[callSid] });

  twiml.say({ voice: "Polly.Joanna" }, DISCLAIMER);

  const actionUrl = `${BASE_URL}/voice/primary-fallback?caller=${encodeURIComponent(callerNumber)}&callSid=${callSid}`;
  const dial = twiml.dial({
    action: actionUrl,
    timeout: RING_TIMEOUT_SECONDS,
    callerId: process.env.TWILIO_PHONE_NUMBER,
  });

  dial.number(
    { url: `${BASE_URL}/voice/whisper?leg=primary` },
    schedule.primaryPhone
  );

  log("ROUTING", { action: "dialing_primary", primaryName: schedule.primaryName, primaryPhone: schedule.primaryPhone });
  res.type("text/xml").send(twiml.toString());
});

// ─── Whisper — plays to the doctor before connecting ───────────────────────
app.post("/voice/whisper", (req, res) => {
  const { leg } = req.query;
  const twiml = new VoiceResponse();

  log("WHISPER", { leg });

  const gather = twiml.gather({
    numDigits: 1,
    action: `${BASE_URL}/voice/whisper-response?leg=${leg}`,
    method: "POST",
    timeout: 10,
  });

  gather.say(
    { voice: "Polly.Joanna" },
    "You have an incoming call on the Ashara Medical Hotline. " +
      "Press 1 to accept and connect to the caller. " +
      "Press any other key or hang up to decline."
  );

  // No key pressed → hang up this leg → triggers <Dial action> fallback
  twiml.hangup();
  res.type("text/xml").send(twiml.toString());
});

// ─── Whisper response ───────────────────────────────────────────────────────
app.post("/voice/whisper-response", (req, res) => {
  const { leg } = req.query;
  const digit = req.body.Digits;
  const twiml = new VoiceResponse();

  log("WHISPER_RESPONSE", { leg, digit });

  if (digit === "1") {
    log("WHISPER_RESPONSE", `${leg} doctor accepted`);
    twiml.say({ voice: "Polly.Joanna" }, "Connecting you now.");
  } else {
    log("WHISPER_RESPONSE", `${leg} doctor declined (pressed ${digit})`);
    twiml.hangup();
  }

  res.type("text/xml").send(twiml.toString());
});

// ─── Primary didn't accept → try backup ────────────────────────────────────
app.post("/voice/primary-fallback", async (req, res) => {
  const { caller, callSid } = req.query;
  const dialStatus = req.body.DialCallStatus;
  const doctorAccepted = req.body.DialBridged === "true";
  const twiml = new VoiceResponse();

  log("PRIMARY_FALLBACK", { caller, callSid, dialStatus, doctorAccepted });

  if (doctorAccepted) {
    // Connected — update leg state to primary so status callback can detect a disconnect
    callState[callSid] = { leg: "primary", caller };
    log("PRIMARY_FALLBACK", "Primary accepted — call bridged");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  // Not accepted — move to backup
  await dialBackup({ caller, callSid, twiml });
  res.type("text/xml").send(twiml.toString());
});

// ─── Backup didn't accept → try coordinator ─────────────────────────────────
app.post("/voice/backup-fallback", async (req, res) => {
  const { caller, callSid } = req.query;
  const dialStatus = req.body.DialCallStatus;
  const doctorAccepted = req.body.DialBridged === "true";
  const twiml = new VoiceResponse();

  log("BACKUP_FALLBACK", { caller, callSid, dialStatus, doctorAccepted });

  if (doctorAccepted) {
    callState[callSid] = { leg: "backup", caller };
    log("BACKUP_FALLBACK", "Backup accepted — call bridged");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  // Not accepted — move to coordinator
  await dialCoordinator({ caller, callSid, twiml, reason: "both_unavailable" });
  res.type("text/xml").send(twiml.toString());
});

// ─── Coordinator fallback ───────────────────────────────────────────────────
app.post("/voice/coordinator-fallback", async (req, res) => {
  const { caller, callSid, reason } = req.query;
  const twiml = new VoiceResponse();

  log("COORDINATOR_FALLBACK", { caller, callSid, reason });
  await dialCoordinator({ caller, callSid, twiml, reason });
  res.type("text/xml").send(twiml.toString());
});

// ─── All unavailable ────────────────────────────────────────────────────────
app.post("/voice/all-unavailable", async (req, res) => {
  const { caller, callSid, reason } = req.query;
  const twiml = new VoiceResponse();

  log("ALL_UNAVAILABLE", { caller, callSid, reason, DialBridged: req.body.DialBridged });

  if (req.body.DialBridged === "true") {
    callState[callSid] = { leg: "coordinator", caller };
    log("ALL_UNAVAILABLE", "Coordinator accepted — call bridged");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  log("ALL_UNAVAILABLE", "No one answered — sending SMS alert");
  playGoodbye(twiml);

  setImmediate(async () => {
    try {
      const schedule = await getOnCallSchedule().catch(() => null);
      await sendMissedCallSMS({ caller, reason: reason || "all_unavailable", schedule });
      await logCall({
        caller, callSid,
        timestamp: new Date().toISOString(),
        outcome: "missed",
        reason: reason || "all_unavailable",
        primaryDoctor: schedule?.primaryName || "Unknown",
        backupDoctor: schedule?.backupName || "Unknown",
      });
    } catch (err) {
      log("ALL_UNAVAILABLE_ERROR", { message: err.message });
    }
    delete callState[callSid];
  });

  res.type("text/xml").send(twiml.toString());
});

// ─── Call status callback — handles disconnects ─────────────────────────────
// This is the key endpoint for disconnect recovery.
// When Twilio reports a call as completed, we check:
//   - Was this call connected (DialBridged)?
//   - Was it too short (likely an accidental disconnect)?
//   - Which leg was it on?
// If it looks like a disconnect, we call the NEXT person in the chain.
app.post("/voice/status", async (req, res) => {
  const { CallStatus, From, CallDuration, CallSid } = req.body;
  log("CALL_STATUS", { CallStatus, From, CallDuration, CallSid });

  const duration = parseInt(CallDuration || "0");
  const state = callState[CallSid];

  if (CallStatus === "completed" && state && duration > 0 && duration < MIN_CALL_DURATION) {
    // Short call on an active leg = likely accidental disconnect
    log("DISCONNECT_RECOVERY", {
      callSid: CallSid,
      leg: state.leg,
      duration,
      caller: state.caller,
      message: `Call dropped after ${duration}s — routing to next person`,
    });

    try {
      const schedule = await getOnCallSchedule();
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

      if (state.leg === "primary" && schedule?.backupPhone) {
        // Primary dropped — call backup
        log("DISCONNECT_RECOVERY", "Calling backup due to primary disconnect");
        await client.calls.create({
          to: state.caller,
          from: process.env.TWILIO_PHONE_NUMBER,
          url: `${BASE_URL}/voice/reconnect?nextLeg=backup&originalCaller=${encodeURIComponent(state.caller)}`,
          statusCallback: `${BASE_URL}/voice/status`,
          statusCallbackMethod: "POST",
        });

      } else if (state.leg === "backup" && schedule?.coordinatorPhone) {
        // Backup dropped — call coordinator
        log("DISCONNECT_RECOVERY", "Calling coordinator due to backup disconnect");
        await client.calls.create({
          to: state.caller,
          from: process.env.TWILIO_PHONE_NUMBER,
          url: `${BASE_URL}/voice/reconnect?nextLeg=coordinator&originalCaller=${encodeURIComponent(state.caller)}`,
          statusCallback: `${BASE_URL}/voice/status`,
          statusCallbackMethod: "POST",
        });
      }
    } catch (err) {
      log("DISCONNECT_RECOVERY_ERROR", { message: err.message });
    }

  } else if (CallStatus === "completed" && duration >= MIN_CALL_DURATION) {
    // Normal completed call — log it
    try {
      const state = callState[CallSid];
      const schedule = await getOnCallSchedule().catch(() => null);
      const leg = state?.leg || "primary";
      const doctorName = leg === "backup"
        ? (schedule?.backupName || "Backup Doctor")
        : leg === "coordinator"
        ? (schedule?.coordinatorName || "Coordinator")
        : (schedule?.primaryName || "Primary Doctor");
      await logCall({
        caller: From,
        callSid: CallSid,
        timestamp: new Date().toISOString(),
        outcome: "answered",
        duration: CallDuration,
        primaryDoctor: doctorName,
      });
    } catch (err) {
      log("CALL_STATUS_ERROR", { message: err.message });
    }
    delete callState[CallSid];
  }

  res.sendStatus(204);
});

// ─── Reconnect — called back to caller after a disconnect ──────────────────
// Twilio calls the ORIGINAL CALLER back and connects them to the next doctor
app.post("/voice/reconnect", async (req, res) => {
  const { nextLeg, originalCaller } = req.query;
  const callSid = req.body.CallSid;
  const twiml = new VoiceResponse();

  log("RECONNECT", { nextLeg, originalCaller, callSid });

  let schedule;
  try {
    schedule = await getOnCallSchedule();
  } catch (err) {
    schedule = null;
  }

  twiml.say(
    { voice: "Polly.Joanna" },
    "We're sorry your call was disconnected. " +
      "We are now connecting you to the next available doctor. Please hold."
  );

  if (nextLeg === "backup" && schedule?.backupPhone) {
    callState[callSid] = { leg: "backup", caller: originalCaller };
    const dial = twiml.dial({
      action: `${BASE_URL}/voice/backup-fallback?caller=${encodeURIComponent(originalCaller)}&callSid=${callSid}`,
      timeout: RING_TIMEOUT_SECONDS,
      callerId: process.env.TWILIO_PHONE_NUMBER,
    });
    dial.number(
      { url: `${BASE_URL}/voice/whisper?leg=backup` },
      schedule.backupPhone
    );
    log("RECONNECT", { action: "dialing_backup", backupPhone: schedule.backupPhone });

  } else if (nextLeg === "coordinator" && schedule?.coordinatorPhone) {
    callState[callSid] = { leg: "coordinator", caller: originalCaller };
    const dial = twiml.dial({
      action: `${BASE_URL}/voice/all-unavailable?caller=${encodeURIComponent(originalCaller)}&callSid=${callSid}&reason=backup_disconnected`,
      timeout: RING_TIMEOUT_SECONDS,
      callerId: process.env.TWILIO_PHONE_NUMBER,
    });
    dial.number(schedule.coordinatorPhone);
    log("RECONNECT", { action: "dialing_coordinator", coordinatorPhone: schedule.coordinatorPhone });

  } else {
    // No one left to try
    log("RECONNECT", "No next leg available — goodbye");
    playGoodbye(twiml);
    setImmediate(async () => {
      await sendMissedCallSMS({ caller: originalCaller, reason: "disconnected_all_unavailable", schedule });
    });
  }

  res.type("text/xml").send(twiml.toString());
});

// ─── Helpers ────────────────────────────────────────────────────────────────
async function dialBackup({ caller, callSid, twiml }) {
  let schedule;
  try { schedule = await getOnCallSchedule(); } catch (_) { schedule = null; }

  if (schedule?.backupPhone) {
    twiml.say({ voice: "Polly.Joanna" }, "Please continue to hold. Connecting you to the backup doctor.");
    const dial = twiml.dial({
      action: `${BASE_URL}/voice/backup-fallback?caller=${encodeURIComponent(caller)}&callSid=${callSid}`,
      timeout: RING_TIMEOUT_SECONDS,
      callerId: process.env.TWILIO_PHONE_NUMBER,
    });
    dial.number({ url: `${BASE_URL}/voice/whisper?leg=backup` }, schedule.backupPhone);
    log("ROUTING", { action: "dialing_backup", backupName: schedule.backupName });
  } else {
    await dialCoordinator({ caller, callSid, twiml, reason: "primary_unavailable" });
  }
}

async function dialCoordinator({ caller, callSid, twiml, reason }) {
  let schedule;
  try { schedule = await getOnCallSchedule(); } catch (_) { schedule = null; }

  if (schedule?.coordinatorPhone) {
    twiml.say({ voice: "Polly.Joanna" }, "Please continue to hold. Connecting you to a coordinator.");
    const dial = twiml.dial({
      action: `${BASE_URL}/voice/all-unavailable?caller=${encodeURIComponent(caller)}&callSid=${callSid}&reason=${reason}`,
      timeout: RING_TIMEOUT_SECONDS,
      callerId: process.env.TWILIO_PHONE_NUMBER,
      answerOnBridge: true,
    });
    // Coordinator also uses whisper to prevent their voicemail from intercepting
    dial.number(
      { url: `${BASE_URL}/voice/whisper?leg=coordinator` },
      schedule.coordinatorPhone
    );
    log("ROUTING", { action: "dialing_coordinator", coordinatorName: schedule.coordinatorName });
  } else {
    twiml.redirect(
      `${BASE_URL}/voice/all-unavailable?caller=${encodeURIComponent(caller)}&callSid=${callSid}&reason=${reason}`
    );
  }
}

function playGoodbye(twiml) {
  twiml.say(
    { voice: "Polly.Joanna" },
    "We are sorry that nobody was available to take your call. " +
      "We will call you back as soon as possible. " +
      "If this is a medical emergency, please hang up and call 9 1 1. Goodbye."
  );
  twiml.hangup();
}

// ─── Recording status callback ──────────────────────────────────────────────
app.post("/voice/recording-status", (req, res) => {
  log("RECORDING_STATUS", { RecordingUrl: req.body.RecordingUrl });
  res.sendStatus(204);
});

// ─── Debug endpoint ─────────────────────────────────────────────────────────
app.get("/schedule/debug", async (req, res) => {
  if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(await getDebugInfo()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Health check ───────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString(), activeCalls: Object.keys(callState).length });
});

// ─── Current schedule (admin) ───────────────────────────────────────────────
app.get("/schedule/current", async (req, res) => {
  if (req.query.token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  try {
    const schedule = await getOnCallSchedule();
    res.json(schedule || { message: "No active schedule found for current time" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Ashara Medical Hotline server running on port ${PORT}`);
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`RING_TIMEOUT_SECONDS: ${RING_TIMEOUT_SECONDS}`);
  console.log(`MIN_CALL_DURATION: ${MIN_CALL_DURATION}s (shorter = accidental disconnect)`);
});
