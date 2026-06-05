# Ashara 1448 - Dallas Relay Center Medical Hotline

A dedicated phone hotline for the Ashara community to reach an on-call doctor for non-emergency medical guidance. Calls are automatically routed based on a schedule maintained in Google Sheets — no coding or IT involvement required for day-to-day operations.

---

## How It Works

Community members dial one dedicated phone number. The system plays a short disclaimer, then automatically connects the caller to the doctor currently on duty. If the primary doctor doesn't answer, it tries the backup doctor. If neither is available, the caller is routed to a coordinator or voicemail, and an SMS alert is sent immediately.

```
Caller dials
      ↓
Disclaimer plays
      ↓
Primary doctor rings (25 sec) ← hangs up if voicemail detected
      ↓ no answer
Backup doctor rings (25 sec) ← hangs up if voicemail detected
      ↓ no answer
Coordinator rings (25 sec)
      ↓ no answer
Polite goodbye message plays + SMS sent instantly:

"The number +1-469-XXX-XXXX called Ashara 1448 Dallas Relay Center 
Hotline & could not connect to any of the doctors. Please follow up 
to check if any assistance is needed."
```

Doctor phone numbers are never revealed to callers. All calls display the hotline number as the caller ID.

> ⚠️ This hotline is for **non-emergency medical guidance only**. For emergencies, always call 911.

---

## For Volunteers — Managing the Schedule

Open the shared Google Sheet and edit the **Schedule** tab. No logins, no apps, no IT support needed. Changes go live within 60 seconds.

### Schedule Tab Columns

| Column | Field | Example |
|--------|-------|---------|
| A | Date | 2026-06-15 |
| B | Start Time | 08:00 |
| C | End Time | 20:00 |
| D | Primary Doctor Name | Dr. Tasneem |
| E | Primary Doctor Phone | +12145550101 |
| F | Backup Doctor Name | Dr. Taskeen |
| G | Backup Doctor Phone | +14695550102 |
| H | Coordinator Name | Sr. Maryam *(optional)* |
| I | Coordinator Phone | +14695550103 *(optional)* |
| J | Notes | Weekday shift *(optional)* |

**Tips:**
- Date format: `YYYY-MM-DD` (e.g., `2026-06-15`) or `M/D/YYYY`
- Time format: `HH:MM` 24-hour (e.g., `08:00`, `20:00`) or `H:MM AM/PM`
- Phone numbers: 10-digit US (e.g., `2145550101`) or full format (e.g., `+12145550101`)
- Overnight shifts (e.g., `20:00` to `08:00`) are supported automatically
- Coordinator column is optional — leave blank if not needed

### Call Log Tab

Every call is recorded automatically in the **Call Log** tab:

| Column | Field |
|--------|-------|
| A | Timestamp |
| B | Caller (last 4 digits shown only) |
| C | Outcome (answered / voicemail) |
| D | On-call Doctor |
| E | Call Duration (seconds) |
| F | Reason (for missed/voicemail calls) |
| G | Call SID |

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Phone number & call routing | [Twilio](https://twilio.com) |
| Schedule & call log storage | Google Sheets |
| Application server | Node.js + Express |
| Hosting | Railway |
| Voicemail detection | Twilio Answering Machine Detection |

---

## Project Structure

```
ashara-hotline/
├── src/
│   ├── server.js         # Express app — all call routing logic & Twilio webhooks
│   ├── schedule.js       # Reads Google Sheet, finds active on-call entry
│   ├── callLog.js        # Appends call records to Call Log sheet
│   └── notifications.js  # Sends SMS alerts for missed calls
├── package.json
├── Dockerfile
├── .env.example          # All required environment variables
└── README.md
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in all values.

| Variable | Description |
|----------|-------------|
| `TWILIO_ACCOUNT_SID` | Twilio Account SID (starts with AC...) |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token |
| `TWILIO_PHONE_NUMBER` | Hotline number in E.164 format (e.g., +18335550100) |
| `GOOGLE_SHEET_ID` | ID from the Google Sheet URL |
| `GOOGLE_SHEET_NAME` | Schedule tab name (default: `Schedule`) |
| `GOOGLE_LOG_SHEET_NAME` | Call log tab name (default: `Call Log`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full service account JSON (minified to one line) |
| `BASE_URL` | Your deployed app URL (e.g., `https://your-app.up.railway.app`) |
| `RING_TIMEOUT_SECONDS` | Seconds to ring each doctor before fallback (default: `25`) |
| `MISSED_CALL_NOTIFY_NUMBERS` | Comma-separated numbers to SMS on missed calls |
| `ADMIN_TOKEN` | Secret token for admin endpoints |
| `TIMEZONE` | Timezone for SMS timestamps (e.g., `America/Chicago`) |
| `TZ` | System timezone for Node.js (e.g., `America/Chicago`) |

---

## Admin Endpoints

Both endpoints require `?token=YOUR_ADMIN_TOKEN`.

**Check current on-call schedule:**
```
GET /schedule/current?token=YOUR_ADMIN_TOKEN
```

**Debug schedule matching (shows server time vs sheet rows):**
```
GET /schedule/debug?token=YOUR_ADMIN_TOKEN
```

**Health check:**
```
GET /health
```

---

## Twilio Webhook Configuration

In Twilio Console → Phone Numbers → your hotline number:

| Field | Value |
|-------|-------|
| A Call Comes In | `https://your-app.up.railway.app/voice/incoming` (HTTP POST) |
| Call Status Changes | `https://your-app.up.railway.app/voice/status` (HTTP POST) |

---

## Estimated Monthly Cost

| Service | Cost |
|---------|------|
| Twilio phone number | ~$1.15/month |
| Twilio inbound calls | $0.0085/min |
| Twilio outbound calls (to doctors) | $0.013/min |
| Twilio SMS alerts | $0.0079/message |
| Railway hosting | Free tier |
| Google Sheets API | Free |
| **Total (~100 calls/month)** | **~$5–10/month** |

---

## Support & Troubleshooting

| Symptom | Fix |
|---------|-----|
| "No active schedule found" | Check date in Google Sheet matches today; verify `TZ` env var is set |
| Call goes to voicemail without trying backup | Answering machine detection triggered — doctor's voicemail answered; this is expected behavior |
| #ERROR! in Call Log | Ensure you're using the latest `callLog.js` |
| SMS alerts not arriving | Check `MISSED_CALL_NOTIFY_NUMBERS` is set with valid E.164 numbers |
| Domain not generating on Railway | Check Deployments tab for errors first |

---

*Built with Twilio + Google Sheets. Maintained by the Ashara community.*
