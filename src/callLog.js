/**
 * callLog.js
 * Appends call records to a "Call Log" tab in the same Google Sheet.
 *
 * Log sheet columns:
 *   A: Timestamp
 *   B: Caller Number (masked)
 *   C: Outcome (answered / voicemail / missed)
 *   D: Doctor Who Answered
 *   E: Call Duration (seconds)
 *   F: Reason (e.g., both_unavailable) — only set for voicemail/missed calls
 *   G: Call SID
 */

const { google } = require("googleapis");

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const LOG_SHEET_NAME = process.env.GOOGLE_LOG_SHEET_NAME || "Call Log";

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
            timestamp || new Date().toISOString(),
            maskPhone(caller),   // prefixed with ' so Sheets treats as plain text
            outcome || "",
            primaryDoctor || "",
            duration || "",
            reason || "",
            callSid || "",
          ],
        ],
      },
    });

    console.log(`[callLog] Logged: ${outcome} from ${maskPhone(caller)}`);
  } catch (err) {
    // Non-fatal — don't let logging failures break call routing
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
