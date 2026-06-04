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
const DISCLAIMER =
  process.env.DISCLAIMER_MESSAGE ||
  "For medical emergencies, please call 9 1 1. " +
    "This hotline is for non-emergency medical guidance only. " +
    "Please hold while we connect you to the on-call doctor.";

// ─── Incoming Call ──────────────────────────────────────────────────────────
app.post("/voice/incoming", async (req, res) => {
  const twiml = new VoiceResponse();
  const callerNumber = req.body.From || "Unknown";
  const callSid = req.body.CallSid;

  console.log(`[${new Date().toISOString()}] Incoming call from ${callerNumber} (${callSid})`);

  let schedule;
  try {
    schedule = await getOnCallSchedule();
  } catch (err) {
    console.error("Failed to read schedule:", err);
    twiml.say(
      { voice: "Polly.Joanna", language: "en-US" },
      "We're sorry, the medical hotline is temporarily unavailable. " +
        "For medical emergencies, please call 9 1 1."
    );
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  if (!schedule || !schedule.primaryPhone) {
    // No one scheduled — go straight to voicemail
    twiml.say({ voice: "Polly.Joanna" }, DISCLAIMER);
    twiml.redirect(
      `/voice/voicemail?caller=${encodeURIComponent(callerNumber)}&callSid=${callSid}&reason=no_schedule`
    );
    return res.type("text/xml").send(twiml.toString());
  }

  // Play disclaimer then dial primary doctor
  twiml.say({ voice: "Polly.Joanna" }, DISCLAIMER);

  const dial = twiml.dial({
    action: `/voice/primary-fallback?caller=${encodeURIComponent(callerNumber)}&callSid=${callSid}`,
    timeout: RING_TIMEOUT_SECONDS,
    callerId: process.env.TWILIO_PHONE_NUMBER, // Hides doctor's real number
    record: "record-from-answer-dual",
    recordingStatusCallback: `/voice/recording-status`,
  });

  dial.number(schedule.primaryPhone);

  res.type("text/xml").send(twiml.toString());
});

// ─── Primary doctor didn't answer → try backup ─────────────────────────────
app.post("/voice/primary-fallback", async (req, res) => {
  const { caller, callSid } = req.query;
  const dialStatus = req.body.DialCallStatus;
  const twiml = new VoiceResponse();

  console.log(`[${new Date().toISOString()}] Primary dial status: ${dialStatus}`);

  if (dialStatus === "completed" || dialStatus === "answered") {
    // Primary answered — call is done, logging handled by status callback
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  // Primary didn't answer — try backup
  let schedule;
  try {
    schedule = await getOnCallSchedule();
  } catch (err) {
    schedule = null;
  }

  if (schedule?.backupPhone) {
    twiml.say(
      { voice: "Polly.Joanna" },
      "The primary doctor is unavailable. Connecting you to the backup doctor."
    );

    const dial = twiml.dial({
      action: `/voice/backup-fallback?caller=${encodeURIComponent(caller)}&callSid=${callSid}`,
      timeout: RING_TIMEOUT_SECONDS,
      callerId: process.env.TWILIO_PHONE_NUMBER,
      record: "record-from-answer-dual",
      recordingStatusCallback: `/voice/recording-status`,
    });
    dial.number(schedule.backupPhone);
  } else {
    // No backup configured — go to coordinator or voicemail
    twiml.redirect(
      `/voice/coordinator-fallback?caller=${encodeURIComponent(caller)}&callSid=${callSid}&reason=primary_unavailable`
    );
  }

  res.type("text/xml").send(twiml.toString());
});

// ─── Backup doctor didn't answer → coordinator or voicemail ────────────────
app.post("/voice/backup-fallback", async (req, res) => {
  const { caller, callSid } = req.query;
  const dialStatus = req.body.DialCallStatus;
  const twiml = new VoiceResponse();

  console.log(`[${new Date().toISOString()}] Backup dial status: ${dialStatus}`);

  if (dialStatus === "completed" || dialStatus === "answered") {
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  twiml.redirect(
    `/voice/coordinator-fallback?caller=${encodeURIComponent(caller)}&callSid=${callSid}&reason=both_unavailable`
  );
  res.type("text/xml").send(twiml.toString());
});

// ─── Coordinator fallback ───────────────────────────────────────────────────
app.post("/voice/coordinator-fallback", async (req, res) => {
  const { caller, callSid, reason } = req.query;
  const twiml = new VoiceResponse();

  let schedule;
  try {
    schedule = await getOnCallSchedule();
  } catch (_) {
    schedule = null;
  }

  if (schedule?.coordinatorPhone) {
    twiml.say({ voice: "Polly.Joanna" }, "Connecting you to a coordinator.");
    const dial = twiml.dial({
      action: `/voice/voicemail?caller=${encodeURIComponent(caller)}&callSid=${callSid}&reason=${reason}`,
      timeout: RING_TIMEOUT_SECONDS,
      callerId: process.env.TWILIO_PHONE_NUMBER,
    });
    dial.number(schedule.coordinatorPhone);
  } else {
    twiml.redirect(
      `/voice/voicemail?caller=${encodeURIComponent(caller)}&callSid=${callSid}&reason=${reason}`
    );
  }

  res.type("text/xml").send(twiml.toString());
});

// ─── Voicemail ──────────────────────────────────────────────────────────────
app.post("/voice/voicemail", async (req, res) => {
  const { caller, callSid, reason } = req.query;
  const twiml = new VoiceResponse();

  console.log(`[${new Date().toISOString()}] Routing to voicemail. Reason: ${reason}`);

  twiml.say(
    { voice: "Polly.Joanna" },
    "All of our doctors are currently unavailable. " +
      "Please leave a message with your name, phone number, and a brief description of your concern. " +
      "A doctor will return your call as soon as possible. " +
      "If this is an emergency, please hang up and call 9 1 1."
  );

  twiml.record({
    action: `/voice/voicemail-done?caller=${encodeURIComponent(caller)}&callSid=${callSid}&reason=${reason}`,
    maxLength: 120,
    playBeep: true,
    recordingStatusCallback: `/voice/recording-status`,
  });

  res.type("text/xml").send(twiml.toString());
});

// ─── After voicemail recorded ───────────────────────────────────────────────
app.post("/voice/voicemail-done", async (req, res) => {
  const { caller, reason } = req.query;
  const twiml = new VoiceResponse();

  twiml.say(
    { voice: "Polly.Joanna" },
    "Thank you for your message. A doctor will call you back shortly. Goodbye."
  );
  twiml.hangup();

  // Log missed call and send SMS notification
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
    console.error("Post-voicemail logging error:", err);
  }

  res.type("text/xml").send(twiml.toString());
});

// ─── Call status callback (answered calls) ─────────────────────────────────
app.post("/voice/status", async (req, res) => {
  const { CallStatus, From, CallDuration, CallSid } = req.body;

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
      console.error("Status callback logging error:", err);
    }
  }

  res.sendStatus(204);
});

// ─── Recording status callback ──────────────────────────────────────────────
app.post("/voice/recording-status", (req, res) => {
  console.log(`Recording ready: ${req.body.RecordingUrl}`);
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

// ─── Current schedule preview (for admins) ─────────────────────────────────
app.get("/schedule/current", async (req, res) => {
  // Simple token auth to protect this endpoint
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
});
