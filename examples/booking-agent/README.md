# Booking agent (example)

A real meeting-booking agent. Guests chat with it on a web page. It checks your Google Calendar, offers open times in their time zone, and books the meeting with a Google Meet link. Google emails the invite to the guest.

It's also the reference example for create-evals: see [evals/](evals) for its binding, its in-memory calendar, and 15 tests, and [evals/evals.md](evals/evals.md) for what they check.

- **Stack:** TypeScript, Vercel AI SDK, Claude (`claude-opus-5-5`), Google Calendar REST API, Node 26 (`Temporal` for time zones)
- **No mocks:** availability comes from your calendar's free/busy, and bookings are real events

## What guests can do

| Tool | What it does | Guarded by |
|---|---|---|
| `find_open_times` | Open slots between two dates, in the guest's time zone | Working days and hours, notice, horizon, buffer |
| `book_meeting` | Creates the event with a Meet link and invites the guest | Re-checks the slot, per-day cap; the prompt requires the guest to confirm first |
| `find_booking` | Looks up a booking | Booking code from the invite plus the matching email |
| `reschedule_booking` | Moves a booking; Google emails the update | Code plus email, and the same slot rules |
| `cancel_booking` | Cancels a booking; Google emails the cancellation | Code plus email |

The agent only sees free/busy blocks, never the titles or attendees of your other events. It can only find or change events it created, and only for the guest who holds that booking's code.

## Setup

### 1. Google OAuth client (one time, about 5 minutes)

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create a project (e.g. "booking-agent").
2. Enable the **Google Calendar API**: APIs & Services → Library → Google Calendar API → Enable.
3. Open **Google Auth Platform**:
   - **Branding:** set an app name and your email.
   - **Audience:** choose Internal if you're on Google Workspace. Otherwise choose External, add yourself as a test user, then click **Publish app**. Without publishing, Google expires the sign-in after 7 days.
   - **Clients:** Create client → **Desktop app**. Copy the client ID and secret.

### 2. Configure and connect

```bash
npm install
cp .env.example .env    # fill in ANTHROPIC_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, OWNER_NAME
npm run auth            # opens Google sign-in, saves the refresh token and your calendar's time zone to .env
```

Google may warn that the app isn't verified. That's expected for your own client: click Advanced, then continue.

### 3. Run it

```bash
npm start               # http://localhost:3000, the page guests use
npm run chat            # the same agent in the terminal
npm test                # unit tests for the slot math
npm run evals           # create-evals scenario tests (real model calls)
```

To let other people use it, host it anywhere that runs Node 26 (Fly, Render, Railway, a VPS) with the same `.env`. Set `PUBLIC_URL` so invites tell guests where to reschedule. For a quick share from your machine, a tunnel works too (`cloudflared tunnel --url http://localhost:3000`).

## Booking rules

These are set in `.env`; the defaults are shown in `.env.example`.

- Mon–Fri, 10:00–18:00 in your calendar's time zone
- 15, 30, 45 or 60 minutes, with a 10-minute buffer around existing events
- At least 4 hours' notice, at most 21 days ahead
- At most 4 agent-booked meetings per day
- Extra calendars that should block time go in `BUSY_CALENDARS`

## Files

| File | What it does |
|---|---|
| `src/agent.ts` | `chat(messages, guestTimeZone)`: one assistant turn |
| `src/prompt.ts` | System prompt: booking flow, confirmation, privacy |
| `src/tools.ts` | The five tools and their checks |
| `src/availability.ts` | Pure slot math: rules, buffers, time zones |
| `src/google.ts` | Calendar API: free/busy, create, move, cancel |
| `src/server.ts`, `public/index.html` | Web chat, with per-IP rate limiting |
| `src/auth.ts` | One-time Google sign-in |
