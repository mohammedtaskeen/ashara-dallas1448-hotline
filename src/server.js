/**
 * Ashara Community Medical Hotline
 * Twilio + Google Sheets call routing server
 *
 * Call flow:
 * Incoming → Primary Doctor (press 1 to accept) → Backup Doctor → Coordinator → SMS alert
 * Voicemail is completely bypassed via whisper confirmation.
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
const DISCLAIMER =
  process.env.DISCLAIMER_MESSAGE ||
  "For medical emergencies, please call 9 1 1. " +
    "This hotline is for non-emergency medical guidance only. " +
    "Please hold while we connect you to the on-call doctor.";

function log(label, data) {
  console.log(`[${new Date().toISOString()}] [${label}]`, JSON.stringify(data, null, 2));
}

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
      await logCall({
        caller: callerNumber,
        callSid,
        timestamp: new Date().toISOString(),
        outcome: "missed",
        reason: "no_schedule",
      });
    });

    return res.type("text/xml").send(twiml.toString());
  }

  twiml.say({ voice: "Polly.Joanna" }, DISCLAIMER);

  const actionUrl = `${BASE_URL}/voice/primary-fallback?caller=${encodeURIComponent(callerNumber)}&callSid=${callSid}`;
  log("ROUTING", {
    action: "dialing_primary",
    primaryName: schedule.primaryName,
    primaryPhone: schedule.primaryPhone,
    timeout: RING_TIMEOUT_SECONDS,
    actionUrl,
  });

  const dial = twiml.dial({
    action: actionUrl,
    timeout: RING_TIMEOUT_SECONDS,
    callerId: process.env.TWILIO_PHONE_NUMBER,
  });

  // url= is the whisper: plays ONLY to the doctor when they pick up,
  // before the two parties are bridged together
  dial.number(
    { url: `${BASE_URL}/voice/whisper?leg=primary` },
    schedule.primaryPhone
  );

  log("TWIML_RESPONSE", { twiml: twiml.toString() });
  res.type("text/xml").send(twiml.toString());
});

// ─── Whisper — plays to the DOCTOR before connecting ───────────────────────
// The caller hears hold music. The doctor hears this prompt.
// If doctor presses 1 → call bridges. Anything else or no input → hangs up
// doctor leg, which triggers the <Dial action> fallback.
app.post("/voice/whisper", (req, res) => {
  const { leg } = req.query;
  const twiml = new VoiceResponse();

  log("WHISPER", { leg, body: req.body });

  // <Gather> waits for doctor to press a key
  const gather = twiml.gather({
    numDigits: 1,
    action: `${BASE_URL}/voice/whisper-response?leg=${leg}`,
    method: "POST",
    timeout: 10, // seconds to wait for key press
  });

  gather.say(
    { voice: "Polly.Joanna" },
    "You have an incoming call on the Ashara Medical Hotline. " +
      "Press 1 to accept and connect to the caller. " +
      "Press any other key or hang up to decline."
  );

  // If no key pressed within timeout, hang up this leg
  // This triggers the <Dial action> fallback to try the next doctor
  twiml.hangup();

  log("WHISPER_TWIML", { twiml: twiml.toString() });
  res.type("text/xml").send(twiml.toString());
});

// ─── Whisper response — doctor pressed a key ───────────────────────────────
app.post("/voice/whisper-response", (req, res) => {
  const { leg } = req.query;
  const digit = req.body.Digits;
  const twiml = new VoiceResponse();

  log("WHISPER_RESPONSE", { leg, digit });

  if (digit === "1") {
    // Doctor accepted — bridge the call
    log("WHISPER_RESPONSE", `${leg} doctor accepted the call`);
    twiml.say({ voice: "Polly.Joanna" }, "Connecting you now.");
  } else {
    // Doctor declined — hang up this leg, triggers <Dial action> fallback
    log("WHISPER_RESPONSE", `${leg} doctor declined (pressed ${digit}) — hanging up`);
    twiml.hangup();
  }

  res.type("text/xml").send(twiml.toString());
});

// ─── Primary didn't accept → try backup ────────────────────────────────────
app.post("/voice/primary-fallback", async (req, res) => {
  const { caller, callSid } = req.query;
  const dialStatus = req.body.DialCallStatus;
  const twiml = new VoiceResponse();

  log("PRIMARY_FALLBACK", { caller, callSid, dialStatus, DialBridged: req.body.DialBridged });

  // DialBridged=true AND status=completed means whisper completed and doctor accepted
  const doctorAccepted = req.body.DialBridged === "true";

  if (doctorAccepted) {
    log("PRIMARY_FALLBACK", "Primary accepted the call — complete");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  log("PRIMARY_FALLBACK", `Primary did not accept (${dialStatus}) — trying backup`);

  let schedule;
  try {
    schedule = await getOnCallSchedule();
  } catch (err) {
    schedule = null;
  }

  if (schedule?.backupPhone) {
    const actionUrl = `${BASE_URL}/voice/backup-fallback?caller=${encodeURIComponent(caller)}&callSid=${callSid}`;
    log("ROUTING", {
      action: "dialing_backup",
      backupName: schedule.backupName,
      backupPhone: schedule.backupPhone,
    });

    twiml.say(
      { voice: "Polly.Joanna" },
      "Please continue to hold. Connecting you to the backup doctor."
    );

    const dial = twiml.dial({
      action: actionUrl,
      timeout: RING_TIMEOUT_SECONDS,
      callerId: process.env.TWILIO_PHONE_NUMBER,
    });

    dial.number(
      { url: `${BASE_URL}/voice/whisper?leg=backup` },
      schedule.backupPhone
    );
  } else {
    twiml.redirect(
      `${BASE_URL}/voice/coordinator-fallback?caller=${encodeURIComponent(caller)}&callSid=${callSid}&reason=primary_unavailable`
    );
  }

  log("TWIML_RESPONSE", { twiml: twiml.toString() });
  res.type("text/xml").send(twiml.toString());
});

// ─── Backup didn't accept → try coordinator ─────────────────────────────────
app.post("/voice/backup-fallback", async (req, res) => {
  const { caller, callSid } = req.query;
  const dialStatus = req.body.DialCallStatus;
  const twiml = new VoiceResponse();

  log("BACKUP_FALLBACK", { caller, callSid, dialStatus, DialBridged: req.body.DialBridged });

  const doctorAccepted = req.body.DialBridged === "true";

  if (doctorAccepted) {
    log("BACKUP_FALLBACK", "Backup accepted the call — complete");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  log("BACKUP_FALLBACK", "Backup did not accept — trying coordinator");

  twiml.redirect(
    `${BASE_URL}/voice/coordinator-fallback?caller=${encodeURIComponent(caller)}&callSid=${callSid}&reason=both_unavailable`
  );
  res.type("text/xml").send(twiml.toString());
});

// ─── Coordinator fallback ───────────────────────────────────────────────────
app.post("/voice/coordinator-fallback", async (req, res) => {
  const { caller, callSid, reason } = req.query;
  const twiml = new VoiceResponse();

  log("COORDINATOR_FALLBACK", { caller, callSid, reason });

  let schedule;
  try {
    schedule = await getOnCallSchedule();
  } catch (_) {
    schedule = null;
  }

  if (schedule?.coordinatorPhone) {
    const actionUrl = `${BASE_URL}/voice/all-unavailable?caller=${encodeURIComponent(caller)}&callSid=${callSid}&reason=${reason}`;
    log("ROUTING", {
      action: "dialing_coordinator",
      coordinatorName: schedule.coordinatorName,
      coordinatorPhone: schedule.coordinatorPhone,
    });

    twiml.say(
      { voice: "Polly.Joanna" },
      "Please continue to hold. Connecting you to a coordinator."
    );

    const dial = twiml.dial({
      action: actionUrl,
      timeout: RING_TIMEOUT_SECONDS,
      callerId: process.env.TWILIO_PHONE_NUMBER,
    });

    // No whisper for coordinator — they just pick up normally
    dial.number(schedule.coordinatorPhone);
  } else {
    twiml.redirect(
      `${BASE_URL}/voice/all-unavailable?caller=${encodeURIComponent(caller)}&callSid=${callSid}&reason=${reason}`
    );
  }

  res.type("text/xml").send(twiml.toString());
});

// ─── All unavailable — goodbye + SMS ───────────────────────────────────────
app.post("/voice/all-unavailable", async (req, res) => {
  const { caller, callSid, reason } = req.query;
  const twiml = new VoiceResponse();

  log("ALL_UNAVAILABLE", { caller, callSid, reason, DialBridged: req.body.DialBridged });

  // Check if coordinator actually answered
  if (req.body.DialBridged === "true") {
    log("ALL_UNAVAILABLE", "Coordinator answered — call complete");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  log("ALL_UNAVAILABLE", "No one answered — sending SMS alert");

  twiml.say(
    { voice: "Polly.Joanna" },
    "We're sorry, all of our doctors and coordinators are currently unavailable. " +
      "Someone will follow up with you as soon as possible. " +
      "If this is a medical emergency, please hang up and call 9 1 1. " +
      "Thank you for calling Ashara Relay Center. Goodbye."
  );
  twiml.hangup();

  setImmediate(async () => {
    try {
      const schedule = await getOnCallSchedule().catch(() => null);
      await sendMissedCallSMS({ caller, reason: reason || "all_unavailable", schedule });
      await logCall({
        caller,
        callSid,
        timestamp: new Date().toISOString(),
        outcome: "missed",
        reason: reason || "all_unavailable",
        primaryDoctor: schedule?.primaryName || "Unknown",
        backupDoctor: schedule?.backupName || "Unknown",
      });
    } catch (err) {
      log("ALL_UNAVAILABLE_ERROR", { message: err.message });
    }
  });

  res.type("text/xml").send(twiml.toString());
});

// ─── Call status callback ───────────────────────────────────────────────────
app.post("/voice/status", async (req, res) => {
  const { CallStatus, From, CallDuration, CallSid } = req.body;
  log("CALL_STATUS", { CallStatus, From, CallDuration, CallSid });

  if (CallStatus === "completed" && parseInt(CallDuration) > 10) {
    try {
      await logCall({
        caller: From,
        callSid: CallSid,
        timestamp: new Date().toISOString(),
        outcome: "answered",
        duration: CallDuration,
      });
    } catch (err) {
      log("CALL_STATUS_ERROR", { message: err.message });
    }
  }

  res.sendStatus(204);
});

// ─── Recording status callback ──────────────────────────────────────────────
app.post("/voice/recording-status", (req, res) => {
  log("RECORDING_STATUS", { RecordingUrl: req.body.RecordingUrl });
  res.sendStatus(204);
});

// ─── Debug endpoint ─────────────────────────────────────────────────────────
app.get("/schedule/debug", async (req, res) => {
  if (req.query.token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    res.json(await getDebugInfo());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ───────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── Current schedule (admin) ───────────────────────────────────────────────
app.get("/schedule/current", async (req, res) => {
  if (req.query.token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const schedule = await getOnCallSchedule();
    res.json(schedule || { message: "No active schedule found for current time" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Ashara Medical Hotline server running on port ${PORT}`);
  console.log(`BASE_URL: ${BASE_URL}`);
  console.log(`RING_TIMEOUT_SECONDS: ${RING_TIMEOUT_SECONDS}`);
});
