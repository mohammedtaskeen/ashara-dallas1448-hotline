/**
 * notifications.js
 * Sends SMS alerts when no one answers the hotline.
 *
 * Recipients configured in MISSED_CALL_NOTIFY_NUMBERS env var
 * as a comma-separated list: +12135550110,+12135550111
 */

const twilio = require("twilio");

async function sendMissedCallSMS({ caller, reason, schedule }) {
  const notifyNumbers = (process.env.MISSED_CALL_NOTIFY_NUMBERS || "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);

  if (!notifyNumbers.length) {
    console.log("[notifications] No MISSED_CALL_NOTIFY_NUMBERS configured — skipping SMS.");
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

  // Format the caller number in readable format e.g. +14691234567 → +1-469-123-4567
  const formattedCaller = formatPhone(caller);

  const body =
    `The number ${formattedCaller} called Ashara 1448 Dallas Relay Center Hotline ` +
    `& could not connect to any of the doctors. ` +
    `Please follow up to check if any assistance is needed.`;

  console.log(`[notifications] Sending SMS: ${body}`);

  const sends = notifyNumbers.map((to) =>
    client.messages
      .create({ body, from: fromNumber, to })
      .then(() => console.log(`[notifications] SMS sent to ${to}`))
      .catch((err) => console.error(`[notifications] SMS to ${to} failed: ${err.message}`))
  );

  await Promise.allSettled(sends);
}

/**
 * Formats a phone number for human readability.
 * +14691234567 → +1-469-123-4567
 * Unknown → Unknown
 */
function formatPhone(phone) {
  if (!phone || phone === "Unknown") return "Unknown";
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1-${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `+1-${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return phone;
}

module.exports = { sendMissedCallSMS };
