/**
 * notifications.js
 * Sends SMS alerts for missed calls via Twilio.
 *
 * Recipients are configured in the env var MISSED_CALL_NOTIFY_NUMBERS
 * as a comma-separated list of phone numbers.
 * e.g., +12135550110,+12135550111
 */

const twilio = require("twilio");

async function sendMissedCallSMS({ caller, reason, schedule }) {
  const notifyNumbers = (process.env.MISSED_CALL_NOTIFY_NUMBERS || "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);

  if (!notifyNumbers.length) {
    console.log("[notifications] No MISSED_CALL_NOTIFY_NUMBERS configured, skipping SMS.");
    return;
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    console.error("[notifications] Twilio credentials not fully configured.");
    return;
  }

  const client = twilio(accountSid, authToken);

  const maskedCaller = caller
    ? caller.slice(0, -4).replace(/\d/g, "*") + caller.slice(-4)
    : "Unknown";

  const reasonText = {
    no_schedule: "No doctor was scheduled",
    primary_unavailable: "Primary doctor did not answer",
    both_unavailable: "Primary and backup doctors did not answer",
  }[reason] || reason;

  const primaryName = schedule?.primaryName || "N/A";
  const backupName = schedule?.backupName || "N/A";

  const body =
    `⚠️ ASHARA HOTLINE — Missed Call\n` +
    `Caller: ${maskedCaller}\n` +
    `Time: ${new Date().toLocaleString("en-US", { timeZone: process.env.TIMEZONE || "America/Chicago" })}\n` +
    `Reason: ${reasonText}\n` +
    `On-call: ${primaryName} / Backup: ${backupName}\n` +
    `Caller left voicemail.`;

  const sends = notifyNumbers.map((to) =>
    client.messages
      .create({ body, from: fromNumber, to })
      .then(() => console.log(`[notifications] SMS sent to ${to}`))
      .catch((err) => console.error(`[notifications] SMS to ${to} failed:`, err.message))
  );

  await Promise.allSettled(sends);
}

module.exports = { sendMissedCallSMS };
