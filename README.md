# Ashara 1448 Dallas Relay Center Hotline

A dedicated community medical relay hotline that automatically connects callers to an on-call physician for non-emergency medical guidance. The system routes calls through a chain of doctors and coordinators, handles accidental disconnects, and alerts coordinators when no one is available — all managed through a simple Google Sheet with no IT involvement required.

---

## For Community Members

**Dial the Ashara 1448 hotline number.**

You will hear:
> *"For medical emergencies, please call 911. This hotline is for non-emergency medical guidance only. Please hold while we connect you to the on-call doctor."*

The system then automatically connects you to the doctor on duty. If the first doctor is unavailable, it tries the backup doctor, then a coordinator. If no one is available, you will hear a message and someone will follow up with you shortly.

> ⚠️ **For emergencies, always call 911. This hotline is for non-emergency guidance only.**

---

## How Calls Are Routed

Every inbound call follows this chain automatically:

```
Caller dials hotline
        │
        ▼
Disclaimer plays
("For medical emergencies, call 911...")
        │
        ▼
Primary On-Call Doctor rings (up to 20 seconds)
Doctor hears: "Press 1 to accept the call"
        │
        ├─ Doctor presses 1 ──────────────────────► Call connected ✓
        │
        ▼ (no answer, voicemail, or declined)
Backup Doctor rings (up to 20 seconds)
Doctor hears: "Press 1 to accept the call"
        │
        ├─ Doctor presses 1 ──────────────────────► Call connected ✓
        │
        ▼ (no answer or declined)
Coordinator rings (up to 20 seconds)
        │
        ├─ Coordinator answers ───────────────────► Call connected ✓
        │
        ▼ (no answer)
Goodbye message plays +
SMS alert sent to coordinators instantly
Call logged to Google Sheet
```

### Disconnect Recovery

If a connected call is accidentally dropped (call duration under 10 seconds):

- **Primary disconnects** → System calls the caller back and connects to the backup doctor
- **Backup disconnects** → System calls the caller back and connects to the coordinator

The caller hears: *"We're sorry your call was disconnected. We are now connecting you to the next available doctor."*

### Voicemail Bypass

Doctors hear a **"Press 1 to accept"** prompt when they pick up, before being connected to the caller. This ensures a doctor's personal carrier voicemail can never accidentally intercept the call — voicemail cannot press 1, so the system immediately moves to the next person in the chain.

### Doctor Privacy

All calls display the hotline number as the Caller ID. Doctor personal phone numbers are never revealed to callers.

---

## For Volunteers — Managing the Schedule

Open the shared Google Sheet and edit the **Schedule** tab. Changes go live automatically within **60 seconds**. No logins, no apps, no IT support needed.

### Schedule Tab — Column Reference

| Column | Field | Format | Example |
|--------|-------|--------|---------|
| A | Date | YYYY-MM-DD or M/D/YYYY | `2026-06-15` |
| B | Start Time | HH:MM (24hr) or H:MM AM/PM | `08:00` or `8:00 AM` |
| C | End Time | HH:MM (24hr) or H:MM AM/PM | `20:00` or `8:00 PM` |
| D | Primary Doctor Name | Text | `Dr. Tasneem` |
| E | Primary Doctor Phone | US number | `+12145550101` |
| F | Backup Doctor Name | Text | `Dr. Taskeen` |
| G | Backup Doctor Phone | US number | `+14695550102` |
| H | Coordinator Name | Text *(optional)* | `Sr. Maryam` |
| I | Coordinator Phone | US number *(optional)* | `+14695550103` |
| J | Notes | Text *(optional)* | `Weekday shift` |

**Tips:**
- Phone numbers can be entered as `2145550101`, `214-555-0101`, or `+12145550101` — all formats work
- Overnight shifts (e.g., `20:00` to `08:00`) are supported automatically
- Leave Coordinator columns blank if not assigned for that shift
- Row 1 must remain the header row — data starts at Row 2

### Call Log Tab

Every call is recorded automatically. Coordinators can review this tab at any time.

| Column | Field | Example |
|--------|-------|---------|
| A | Timestamp | `06/07/2026, 11:27 PM CDT` |
| B | Caller Number | `+1-469-123-4567` |
| C | Outcome | `answered` or `missed` |
| D | Doctor Who Answered | `Dr. Tasneem` |
| E | Call Duration | `67s` |
| F | Reason *(missed calls only)* | `Primary & backup did not answer` |
| G | Call SID | Twilio reference ID |

**Reason field values for missed calls:**

| Reason | Meaning |
|--------|---------|
| No doctor scheduled | No shift entry found for that date/time |
| Primary did not answer | Only backup and coordinator were tried |
| Primary & backup did not answer | Coordinator was tried |
| All doctors & coordinator unavailable | SMS alert was sent |

---

## SMS Alert — When No One Answers

When all doctors and the coordinator are unavailable, the following SMS is sent immediately to all configured coordinator numbers:

> *"The number +1-469-XXX-XXXX called Ashara 1448 Dallas Relay Center Hotline & could not connect to any of the doctors. Please follow up to check if any assistance is needed."*

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Phone number & call routing | [Twilio](https://twilio.com) |
| Schedule & call log | Google Sheets |
| Application server | Node.js + Express |
| Hosting | Railway |
| Spam protection | freecallerregistry.com + Twilio CNAM |

---

## Project Structure

```
ashara-hotline/
├── src/
│   ├── server.js         # All call routing logic & Twilio webhooks
│   ├── schedule.js       # Reads Google Sheet, finds active on-call entry
│   ├── callLog.js        # Logs every call to the Call Log sheet
│   └── notifications.js  # Sends SMS alerts for missed calls
├── package.json
├── Dockerfile
├── .env.example
└── README.md
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in all values. In Railway, set these under the **Variables** tab.

| Variable | Description | Example |
|----------|-------------|---------|
| `TWILIO_ACCOUNT_SID` | Twilio Account SID | `ACxxxxxxxxxxxxxxxx` |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token | `your_auth_token` |
| `TWILIO_PHONE_NUMBER` | Hotline number (E.164) | `+18335550100` |
| `GOOGLE_SHEET_ID` | ID from the Google Sheet URL | `1BxiMVs0XRA5nF...` |
| `GOOGLE_SHEET_NAME` | Schedule tab name | `Schedule` |
| `GOOGLE_LOG_SHEET_NAME` | Call log tab name | `Call Log` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service account key (minified JSON) | `{"type":"service_account"...}` |
| `BASE_URL` | Your deployed app URL | `https://your-app.up.railway.app` |
| `RING_TIMEOUT_SECONDS` | Seconds to ring each doctor | `20` |
| `MIN_CALL_DURATION` | Seconds below which a call is treated as accidental disconnect | `10` |
| `MISSED_CALL_NOTIFY_NUMBERS` | Comma-separated numbers for SMS alerts | `+14695550110,+12145550111` |
| `ADMIN_TOKEN` | Secret token for admin endpoints | `your_secret_token` |
| `TIMEZONE` | Local timezone for log timestamps | `America/Chicago` |
| `TZ` | System timezone for Node.js | `America/Chicago` |

---

## Twilio Webhook Configuration

In Twilio Console → Phone Numbers → your hotline number:

| Field | Value |
|-------|-------|
| A Call Comes In | `https://your-app.up.railway.app/voice/incoming` (HTTP POST) |
| Call Status Changes | `https://your-app.up.railway.app/voice/status` (HTTP POST) |

---

## Admin Endpoints

All endpoints require `?token=YOUR_ADMIN_TOKEN`.

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Server status and active call count |
| `GET /schedule/current?token=` | Shows who is on call right now |
| `GET /schedule/debug?token=` | Full debug view — server time, sheet rows, matching logic |

---

## Estimated Monthly Cost

| Service | Cost |
|---------|------|
| Twilio phone number | ~$1.15/month |
| Twilio inbound calls | $0.0085/min |
| Twilio outbound legs (to doctors) | $0.013/min |
| Twilio SMS alerts | $0.0079/message |
| Railway hosting | Free tier |
| Google Sheets API | Free |
| **Total (~100 calls/month)** | **~$5–10/month** |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "No active schedule found" | Date in sheet doesn't match today, or wrong timezone | Check date format in sheet; verify `TZ=America/Chicago` in Railway variables |
| Call not routing to backup | Whisper timeout too short | Ensure `RING_TIMEOUT_SECONDS=20` and doctor has 10 seconds to press 1 |
| Caller number shows `#ERROR!` in log | Sheets interpreting `+` as formula | Ensure you are using the latest `callLog.js` |
| SMS alerts not arriving | Notify numbers not set | Check `MISSED_CALL_NOTIFY_NUMBERS` in Railway variables |
| "Scam Likely" on caller ID | New number not yet trusted by carriers | Register at freecallerregistry.com; add CNAM in Twilio (~$1.25/month) |
| Disconnect recovery not triggering | Call duration above `MIN_CALL_DURATION` | Lower `MIN_CALL_DURATION` threshold in Railway variables |
| Domain not generating on Railway | Deployment failed | Check Deployments tab for errors before generating domain |

---

## Call Routing Webhook Reference

| Route | Trigger |
|-------|---------|
| `POST /voice/incoming` | Every new inbound call |
| `POST /voice/whisper` | When a doctor picks up — plays "Press 1" prompt |
| `POST /voice/whisper-response` | After doctor presses a key |
| `POST /voice/primary-fallback` | After primary doctor dial attempt ends |
| `POST /voice/backup-fallback` | After backup doctor dial attempt ends |
| `POST /voice/coordinator-fallback` | After both doctors unavailable |
| `POST /voice/all-unavailable` | After coordinator also unavailable |
| `POST /voice/reconnect` | Called when system calls back caller after disconnect |
| `POST /voice/status` | Every call status change — handles disconnect recovery & logging |

---

*Ashara 1448 Dallas Relay Center Hotline — Built with Twilio + Google Sheets. Managed by volunteers.*
