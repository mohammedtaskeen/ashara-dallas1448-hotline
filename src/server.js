/**
 * Ashara Community Medical Hotline
 * Twilio + Google Sheets call routing server
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
const RING_TIMEOUT_SECONDS = parseInt(process.env.RING_TIMEOUT_SECONDS || "25");
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
    log("ROUTING", "No schedule — going to voicemail");
    twiml.say({ voice: "Polly.Joanna" }, DISCLAIMER);
    twiml.redirect(
      `${BASE_URL}/voice/voicemail?caller=${encodeURIComponent(callerNumber)}&callSid=${callSid}&reason=no_schedule`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  const actionUrl = `${BASE_URL}/voice/primary-fallback?caller=${encodeURIComponent(callerNumber)}&callSid=${callSid}`;
  log("ROUTING", {
    action: "dialing_primary",
    primaryName: schedule.primaryName,
    primaryPhone: schedule.primaryPhone,
    timeout: RING_TIMEOUT_SECONDS,
    actionUrl,
  });

  twiml.say({ voice: "Polly.Joanna" }, DISCLAIMER);

  const dial = twiml.dial({
    action: actionUrl,
    timeout: RING_TIMEOUT_SECONDS,
    callerId: process.env.TWILIO_PHONE_NUMBER,
    record: "record-from-answer-dual",
    recordingStatusCallback: `${BASE_URL}/voice/recording-status`,
    // answerOnBridge ensures the call isn't "answered" until the doctor
    // actually speaks — prevents voicemail from hijacking the call
    answerOnBridge: true,
  });

  // machineDetection: tell Twilio to hang up if it detects voicemail
  // asyncAmdStatusCallback fires when detection is done without blocking call flow
  dial.number(
    {
      machineDetection: "Enable",
      asyncAmdStatusCallback: `${BASE_URL}/voice/amd-status?caller=${encodeURIComponent(callerNumber)}&callSid=${callSid}&leg=primary`,
      asyncAmdStatusCallbackMethod: "POST",
    },
    schedule.primaryPhone
  );

  const twimlStr = twiml.toString();
  log("TWIML_RESPONSE", { twiml: twimlStr });
  res.type("text/xml").send(twimlStr);
});

// ─── AMD (Answering Machine Detection) status ───────────────────────────────
// Fires when Twilio determines if primary/backup was a human or machine
app.post("/voice/amd-status", async (req, res) => {
  const { caller, callSid, leg } = req.query;
  const { AnsweredBy, CallSid: childCallSid } = req.body;

  log("AMD_STATUS", { leg, caller, callSid, childCallSid, AnsweredBy, body: req.body });

  // If voicemail detected — hang up the doctor leg so the action URL fires
  if (AnsweredBy === "machine_start" || AnsweredBy === "machine_end_beep" ||
      AnsweredBy === "machine_end_silence" || AnsweredBy === "machine_end_other" ||
      AnsweredBy === "fax") {
    log("AMD_STATUS", `Voicemail detected on ${leg} leg — hanging up doctor call`);
    try {
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await client.calls(childCallSid).update({ status: "completed" });
      log("AMD_STATUS", `Hung up ${leg} doctor leg ${childCallSid}`);
    } catch (err) {
      log("AMD_STATUS_ERROR", { message: err.message });
    }
  } else {
    log("AMD_STATUS", `Human detected on ${leg} leg — call continues normally`);
  }

  res.sendStatus(204);
});

// ─── Primary doctor didn't answer → try backup ─────────────────────────────
app.post("/voice/primary-fallback", async (req, res) => {
  const { caller, callSid } = req.query;
  const dialStatus = req.body.DialCallStatus;
  const twiml = new VoiceResponse();

  log("PRIMARY_FALLBACK", { caller, callSid, dialStatus });

  // "completed" here now means hung up (either by timeout OR by AMD detecting voicemail)
  // "answered" + DialBridged=true means human actually picked up
  const humanAnswered = dialStatus === "completed" && req.body.DialBridged === "true";

  if (humanAnswered) {
    log("PRIMARY_FALLBACK", "Primary human answered — call was handled");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  log("PRIMARY_FALLBACK", `Primary did not answer (status: ${dialStatus}) — trying backup`);

  let schedule;
  try {
    schedule = await getOnCallSchedule();
    log("PRIMARY_FALLBACK_SCHEDULE", schedule || "null");
  } catch (err) {
    log("PRIMARY_FALLBACK_SCHEDULE_ERROR", { message: err.message });
    schedule = null;
  }

  if (schedule?.backupPhone) {
    const actionUrl = `${BASE_URL}/voice/backup-fallback?caller=${encodeURIComponent(caller)}&callSid=${callSid}`;
    log("ROUTING", {
      action: "dialing_backup",
      backupName: schedule.backupName,
      backupPhone: schedule.backupPhone,
      actionUrl,
    });

    twiml.say(
      { voice: "Polly.Joanna" },
      "The primary doctor is unavailable. Connecting you to the backup doctor."
    );

    const dial = twiml.dial({
      action: actionUrl,
      timeout: RING_TIMEOUT_SECONDS,
      callerId: process.env.TWILIO_PHONE_NUMBER,
      record: "record-from-answer-dual",
      recordingStatusCallback: `${BASE_URL}/voice/recording-status`,
      answerOnBridge: true,
    });

    dial.number(
      {
        machineDetection: "Enable",
        asyncAmdStatusCallback: `${BASE_URL}/voice/amd-status?caller=${encodeURIComponent(caller)}&callSid=${callSid}&leg=backup`,
        asyncAmdStatusCallbackMethod: "POST",
      },
      schedule.backupPhone
    );
  } else {
    log("ROUTING", "No backup phone — going to coordinator fallback");
    twiml.redirect(
      `${BASE_URL}/voice/coordinator-fallback?caller=${encodeURIComponent(caller)}&callSid=${callSid}&reason=primary_unavailable`
    );
  }

  const twimlStr = twiml.toString();
  log("TWIML_RESPONSE", { twiml: twimlStr });
  res.type("text/xml").send(twimlStr);
});

// ─── Backup doctor didn't answer → coordinator or voicemail ────────────────
app.post("/voice/backup-fallback", async (req, res) => {
  const { caller, callSid } = req.query;
  const dialStatus = req.body.DialCallStatus;
  const twiml = new VoiceResponse();

  log("BACKUP_FALLBACK", { caller, callSid, dialStatus, DialBridged: req.body.DialBridged });

  const humanAnswered = dialStatus === "completed" && req.body.DialBridged === "true";

  if (humanAnswered) {
    log("BACKUP_FALLBACK", "Backup human answered — call was handled");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  log("ROUTING", "Backup did not answer — going to coordinator fallback");
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
    log("ROUTING", {
      action: "dialing_coordinator",
      coordinatorName: schedule.coordinatorName,
      coordinatorPhone: schedule.coordinatorPhone,
    });
    twiml.say({ voice: "Polly.Joanna" }, "Connecting you to a coordinator.");
    const dial = twiml.dial({
      action: `${BASE_URL}/voice/voicemail?caller=${encodeURIComponent(caller)}&callSid=${callSid}&reason=${reason}`,
      timeout: RING_TIMEOUT_SECONDS,
      callerId: process.env.TWILIO_PHONE_NUMBER,
    });
    dial.number(schedule.coordinatorPhone);
  } else {
    log("ROUTING", "No coordinator — going to voicemail");
    twiml.redirect(
      `${BASE_URL}/voice/voicemail?caller=${encodeURIComponent(caller)}&callSid=${callSid}&reason=${reason}`
    );
  }

  res.type("text/xml").send(twiml.toString());
});

// ─── Voicemail ──────────────────────────────────────────────────────────────
app.post("/voice/voicemail", async (req, res) => {
  const { caller, callSid, reason } = req.query;
  const twiml = new VoiceResponse();

  log("VOICEMAIL", { caller, callSid, reason });

  twiml.say(
    { voice: "Polly.Joanna" },
    "All of our doctors are currently unavailable. " +
      "Please leave a message with your name, phone number, and a brief description of your concern. " +
      "A doctor will return your call as soon as possible. " +
      "If this is an emergency, please hang up and call 9 1 1."
  );

  twiml.record({
    action: `${BASE_URL}/voice/voicemail-done?caller=${encodeURIComponent(caller)}&callSid=${callSid}&reason=${reason}`,
    maxLength: 120,
    playBeep: true,
    recordingStatusCallback: `${BASE_URL}/voice/recording-status`,
  });

  res.type("text/xml").send(twiml.toString());
});

// ─── After voicemail recorded ───────────────────────────────────────────────
app.post("/voice/voicemail-done", async (req, res) => {
  const { caller, reason } = req.query;
  const twiml = new VoiceResponse();

  log("VOICEMAIL_DONE", { caller, reason });

  twiml.say(
    { voice: "Polly.Joanna" },
    "Thank you for your message. A doctor will call you back shortly. Goodbye."
  );
  twiml.hangup();

  try {
    const schedule = await getOnCallSchedule().catch(() => null);
    await logCall({
      caller,
      timestamp: new Date().toISOString(),
      outcome: "voicemail",
      reason,
      primaryDoctor: schedule?.primaryName || "Unknown",
      backupDoctor: schedule?.backupName || "Unknown",
    });
    await sendMissedCallSMS({ caller, reason, schedule });
  } catch (err) {
    log("VOICEMAIL_DONE_ERROR", { message: err.message });
  }

  res.type("text/xml").send(twiml.toString());
});

// ─── Call status callback ───────────────────────────────────────────────────
app.post("/voice/status", async (req, res) => {
  const { CallStatus, From, CallDuration, CallSid } = req.body;
  log("CALL_STATUS", { CallStatus, From, CallDuration, CallSid });

  if (CallStatus === "completed") {
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
  log("RECORDING_STATUS", { RecordingUrl: req.body.RecordingUrl, RecordingStatus: req.body.RecordingStatus });
  res.sendStatus(204);
});

// ─── Debug endpoint (admin only) ────────────────────────────────────────────
app.get("/schedule/debug", async (req, res) => {
  const token = req.query.token;
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const debug = await getDebugInfo();
    res.json(debug);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ───────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── Current schedule preview (admin only) ─────────────────────────────────
app.get("/schedule/current", async (req, res) => {
  const token = req.query.token;
  if (token !== process.env.ADMIN_TOKEN) {
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
