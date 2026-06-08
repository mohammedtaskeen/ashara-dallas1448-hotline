/**
 * callLog.js
 * Appends call records to a "Call Log" tab in the same Google Sheet.
 *
 * Log sheet columns:
 *   A: Timestamp (local timezone)
 *   B: Caller Number (full number)
 *   C: Outcome (answered / missed)
 *   D: Doctor Answered
 *   E: Call Duration (seconds)
 *   F: Reason (missed calls only: no_schedule / primary_unavailable / both_unavailable / all_unavailable)
 *   G: Call SID
 */

const { google } = require("googleapis");

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const LOG_SHEET_NAME = process.env.GOOGLE_LOG_SHEET_NAME || "Call Log";

/**
 * Formats a timestamp in the configured local timezone.
 * e.g., "06/07/2026, 11:27:12 PM CDT"
 */
function formatTimestamp(isoString) {
  const tz = process.env.TIMEZONE || "America/Chicago";
  const date = isoString ? new Date(isoString) : new Date();
  return date.toLocaleString("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
}

/**
 * Formats a phone number for readability.
 * +14691234567 → +1-469-123-4567
 * Prefixed with apostrophe to prevent Google Sheets treating it as a formula.
 */
function formatPhone(phone) {
  if (!phone || phone === "Unknown") return phone;
  const digits = phone.replace(/\D/g, "");
  let formatted;
  if (digits.length === 11 && digits.startsWith("1")) {
    formatted = `+1-${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  } else if (digits.length === 10) {
    formatted = `+1-${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  } else {
    formatted = phone;
  }
  // Apostrophe prefix prevents Sheets from misinterpreting the + sign
  return `'${formatted}`;
}

/**
 * Human-readable reason labels for the log.
 */
const REASON_LABELS = {
  no_schedule:               "No doctor scheduled",
  primary_unavailable:       "Primary did not answer",
  both_unavailable:          "Primary & backup did not answer",
  all_unavailable:           "All doctors & coordinator unavailable",
  backup_disconnected:       "Backup call disconnected",
  disconnected_all_unavailable: "Disconnected — no one else available",
};

async function logCall({ caller, callSid, timestamp, outcome, duration, reason, primaryDoctor, backupDoctor }) {
  try {
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });

    const reasonLabel = reason ? (REASON_LABELS[reason] || reason) : "";
    const doctorLabel = primaryDoctor
      ? backupDoctor && outcome === "answered"
        ? primaryDoctor  // show who answered
        : primaryDoctor
      : "";

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${LOG_SHEET_NAME}!A:G`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [
          [
            formatTimestamp(timestamp),
            formatPhone(caller),
            outcome || "",
            doctorLabel,
            duration ? `${duration}s` : "",
            reasonLabel,
            callSid || "",
          ],
        ],
      },
    });

    console.log(`[callLog] Logged: ${outcome} from ${formatPhone(caller)} at ${formatTimestamp(timestamp)}`);
  } catch (err) {
    console.error("[callLog] Failed to log call:", err.message);
  }
}

async function getGoogleAuth() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!keyJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON env var not set");
  const key = JSON.parse(keyJson);
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

module.exports = { logCall };
