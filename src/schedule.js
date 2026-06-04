/**
 * schedule.js
 * Reads the on-call schedule from a Google Sheet and returns
 * the active entry for the current date/time.
 *
 * Expected sheet columns (Row 1 = headers):
 *   A: Date          (e.g., 2025-06-15  or  6/15/2025)
 *   B: Start Time    (e.g., 08:00 or 8:00 AM)
 *   C: End Time      (e.g., 20:00 or 8:00 PM)
 *   D: Primary Name
 *   E: Primary Phone (e.g., +12135550101)
 *   F: Backup Name
 *   G: Backup Phone  (e.g., +12135550102)
 *   H: Coordinator Name  (optional)
 *   I: Coordinator Phone (optional)
 *   J: Notes             (optional)
 */

const { google } = require("googleapis");

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEET_NAME || "Schedule";
// Cache the schedule for this many milliseconds to avoid hammering Sheets API
const CACHE_TTL_MS = parseInt(process.env.SCHEDULE_CACHE_TTL_MS || "60000"); // 1 minute

let _cache = null;
let _cacheExpiry = 0;

/**
 * Returns the active on-call schedule entry for right now, or null if none.
 */
async function getOnCallSchedule() {
  const now = new Date();

  // Return cached result if still fresh
  if (_cache !== null && Date.now() < _cacheExpiry) {
    return findActiveEntry(_cache, now);
  }

  const rows = await fetchSheetRows();
  _cache = rows;
  _cacheExpiry = Date.now() + CACHE_TTL_MS;

  return findActiveEntry(rows, now);
}

/**
 * Finds the first row whose date + time window covers `now`.
 */
function findActiveEntry(rows, now) {
  for (const row of rows) {
    if (!row.date || !row.startTime || !row.endTime || !row.primaryPhone) continue;

    const start = parseDateTime(row.date, row.startTime);
    const end = parseDateTime(row.date, row.endTime);

    if (!start || !end) continue;

    // Handle schedules that cross midnight (end < start)
    const active =
      end > start
        ? now >= start && now < end
        : now >= start || now < end; // overnight shift

    if (active) return row;
  }
  return null;
}

/**
 * Fetches all rows from the Google Sheet.
 */
async function fetchSheetRows() {
  const auth = await getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A2:J500`, // Skip header row, read up to 500 rows
  });

  const rawRows = response.data.values || [];
  return rawRows.map(parseRow).filter(Boolean);
}

/**
 * Maps a raw row array to a structured object.
 */
function parseRow(cells) {
  if (!cells || cells.length < 5) return null;

  return {
    date: (cells[0] || "").trim(),
    startTime: (cells[1] || "").trim(),
    endTime: (cells[2] || "").trim(),
    primaryName: (cells[3] || "").trim(),
    primaryPhone: normalizePhone(cells[4]),
    backupName: (cells[5] || "").trim(),
    backupPhone: normalizePhone(cells[6]),
    coordinatorName: (cells[7] || "").trim(),
    coordinatorPhone: normalizePhone(cells[8]),
    notes: (cells[9] || "").trim(),
  };
}

/**
 * Parses a date string + time string into a Date object.
 * Supports: "2025-06-15", "6/15/2025"
 * Time:  "08:00", "8:00 AM", "20:00", "8:00 PM", "0:00"
 */
function parseDateTime(dateStr, timeStr) {
  try {
    // Parse date parts directly to avoid UTC vs local timezone issues
    let year, month, day;

    // Try YYYY-MM-DD format first
    const isoMatch = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (isoMatch) {
      year = parseInt(isoMatch[1]);
      month = parseInt(isoMatch[2]) - 1; // 0-indexed
      day = parseInt(isoMatch[3]);
    } else {
      // Try M/D/YYYY format
      const usMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (usMatch) {
        month = parseInt(usMatch[1]) - 1;
        day = parseInt(usMatch[2]);
        year = parseInt(usMatch[3]);
      } else {
        return null;
      }
    }

    // Normalize time
    let hours = 0, minutes = 0;
    const timeLower = timeStr.toLowerCase().trim();

    if (timeLower.includes("am") || timeLower.includes("pm")) {
      // 12-hour format: "8:00 AM" or "8:00PM"
      const match = timeLower.match(/(\d{1,2}):(\d{2})\s*(am|pm)/);
      if (!match) return null;
      hours = parseInt(match[1]);
      minutes = parseInt(match[2]);
      const period = match[3];
      if (period === "pm" && hours !== 12) hours += 12;
      if (period === "am" && hours === 12) hours = 0;
    } else {
      // 24-hour format: "08:00" or "0:00"
      const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
      if (!match) return null;
      hours = parseInt(match[1]);
      minutes = parseInt(match[2]);
    }

    return new Date(year, month, day, hours, minutes, 0);
  } catch (_) {
    return null;
  }
}

/**
 * Returns raw sheet data and server time — for debugging only.
 */
async function getDebugInfo() {
  const now = new Date();
  const rows = await fetchSheetRows();
  return {
    serverTime: now.toISOString(),
    serverTimeLocal: now.toString(),
    timezone: process.env.TZ || "not set",
    rowCount: rows.length,
    rows: rows.map((r) => ({
      ...r,
      parsedStart: parseDateTime(r.date, r.startTime)?.toString(),
      parsedEnd: parseDateTime(r.date, r.endTime)?.toString(),
      nowVsStart: parseDateTime(r.date, r.startTime)
        ? now >= parseDateTime(r.date, r.startTime) ? "now >= start ✓" : "now < start ✗"
        : "parse failed",
      nowVsEnd: parseDateTime(r.date, r.endTime)
        ? now < parseDateTime(r.date, r.endTime) ? "now < end ✓" : "now >= end ✗"
        : "parse failed",
    })),
  };
}

module.exports = { getOnCallSchedule, parseDateTime, normalizePhone, getDebugInfo };

/**
 * Normalizes a phone number to E.164 format.
 * Assumes US numbers if no country code present.
 */
function normalizePhone(raw) {
  if (!raw) return "";
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("1") && digits.length === 11) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length > 10) return `+${digits}`;
  return "";
}

/**
 * Creates a Google auth client using a service account JSON key
 * stored in the environment variable GOOGLE_SERVICE_ACCOUNT_JSON.
 */
async function getGoogleAuth() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!keyJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON env var not set");

  const key = JSON.parse(keyJson);
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return auth;
}

// Export for testing
module.exports = { getOnCallSchedule, parseDateTime, normalizePhone };
