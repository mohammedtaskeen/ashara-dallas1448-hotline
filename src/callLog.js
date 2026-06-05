/**
 * callLog.js
 * Appends call records to a "Call Log" tab in the same Google Sheet.
 *
 * Log sheet columns:
 *   A: Timestamp (in local timezone)
 *   B: Caller Number (masked)
 *   C: Outcome (answered / missed)
 *   D: Doctor
 *   E: Call Duration (seconds)
 *   F: Reason (for missed calls only)
 *   G: Call SID
 */

const { google } = require("googleapis");

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const LOG_SHEET_NAME = process.env.GOOGLE_LOG_SHEET_NAME || "Call Log";

/**
 * Formats a timestamp in the configured local timezone.
 * e.g., "06/05/2026, 2:51:00 PM CDT"
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

async function logCall({ caller, callSid, timestamp, outcome, duration, reason, primaryDoctor, backupDoctor }) {
  try {
    const auth = await getGoogleAuth();
    const sheets = google.sheets({ version: "v4", auth });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${LOG_SHEET_NAME}!A:G`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [
          [
            formatTimestamp(timestamp),
            maskPhone(caller),
            outcome || "",
            primaryDoctor || "",
            duration || "",
            reason || "",
            callSid || "",
          ],
        ],
      },
    });

    console.log(`[callLog] Logged: ${outcome} from ${maskPhone(caller)} at ${formatTimestamp(timestamp)}`);
  } catch (err) {
    console.error("[callLog] Failed to log call:", err.message);
  }
}

/**
 * Masks caller number for privacy — keeps last 4 digits only.
 * The leading apostrophe (') tells Google Sheets to treat the value
 * as plain text, preventing the #ERROR! caused by * characters.
 * e.g., +12135550199 → '***-***-0199
 */
function maskPhone(phone) {
  if (!phone || phone === "Unknown") return phone;
  const last4 = phone.slice(-4);
  return `'***-***-${last4}`;
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
