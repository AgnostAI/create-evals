// The Google Calendar REST API over fetch, with an OAuth refresh token from `npm run auth`.
import { config } from "./config.js";
import { requireEnv } from "./env.js";
import type { Interval } from "./availability.js";
import type { Booking, Calendar, NewBooking } from "./calendar.js";

export const SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.freebusy"];
const API = "https://www.googleapis.com/calendar/v3";

let cached: { token: string; expires: number } | undefined;

async function accessToken(): Promise<string> {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
      refresh_token: requireEnv("GOOGLE_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!body.access_token) throw new Error(`Google sign-in failed: ${body.error_description ?? body.error ?? res.status}. Run \`npm run auth\` again.`);
  cached = { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cached.token;
}

async function gcal<T>(method: string, path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<T> {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (res.status === 204) return undefined as T;
  const body = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(`Google Calendar ${method} ${path} failed (${res.status}): ${body.error?.message ?? "unknown error"}`);
  return body;
}

const cal = () => `/calendars/${encodeURIComponent(config.calendarId)}`;

/** Busy blocks across the booking calendar and any extra busy calendars. Titles never leave Google. */
async function busyBetween(from: Temporal.Instant, to: Temporal.Instant): Promise<Interval[]> {
  const ids = [config.calendarId, ...config.busyCalendars];
  const res = await gcal<{ calendars: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }> }>("POST", "/freeBusy", {
    body: { timeMin: from.toString(), timeMax: to.toString(), items: ids.map((id) => ({ id })) },
  });
  return Object.entries(res.calendars).flatMap(([id, c]) => {
    if (c.errors?.length) throw new Error(`Can't read free/busy for ${id}: ${c.errors.map((e) => e.reason).join(", ")}`);
    return (c.busy ?? []).map((b) => ({ start: Temporal.Instant.from(b.start), end: Temporal.Instant.from(b.end) }));
  });
}

interface GEvent {
  id: string;
  start: { dateTime?: string };
  end: { dateTime?: string };
  hangoutLink?: string;
  extendedProperties?: { private?: Record<string, string> };
}

const AGENT_TAG = { bookedBy: "booking-agent" };

function toBooking(e: GEvent): Booking | undefined {
  const p = e.extendedProperties?.private ?? {};
  if (p.bookedBy !== AGENT_TAG.bookedBy || !e.start.dateTime || !e.end.dateTime) return undefined;
  return {
    id: e.id,
    code: p.bookingCode ?? "",
    guestName: p.guestName ?? "",
    guestEmail: p.guestEmail ?? "",
    topic: p.topic ?? "",
    start: Temporal.Instant.from(e.start.dateTime),
    end: Temporal.Instant.from(e.end.dateTime),
    meetLink: e.hangoutLink,
  };
}

/** Meetings this agent booked that start inside [from, to). */
async function agentBookingsBetween(from: Temporal.Instant, to: Temporal.Instant): Promise<Booking[]> {
  const res = await gcal<{ items: GEvent[] }>("GET", `${cal()}/events`, {
    query: { privateExtendedProperty: `bookedBy=${AGENT_TAG.bookedBy}`, timeMin: from.toString(), timeMax: to.toString(), singleEvents: "true", maxResults: "50" },
  });
  return res.items.map(toBooking).filter((b): b is Booking => !!b && Temporal.Instant.compare(b.start, from) >= 0);
}

async function findBookingByCode(code: string): Promise<Booking | undefined> {
  const res = await gcal<{ items: GEvent[] }>("GET", `${cal()}/events`, {
    query: { privateExtendedProperty: `bookingCode=${code}`, singleEvents: "true", maxResults: "5" },
  });
  return res.items.map(toBooking).find((b) => b?.code === code);
}

/** Creates the event with a Google Meet link; Google emails the invite to the guest. */
async function createBooking(b: NewBooking): Promise<Booking> {
  const ownerName = config.ownerName;
  const reschedule = config.publicUrl ? ` at ${config.publicUrl}` : "";
  const event = await gcal<GEvent>("POST", `${cal()}/events`, {
    query: { conferenceDataVersion: "1", sendUpdates: "all" },
    body: {
      summary: `${b.guestName} <> ${ownerName}`,
      description: `${b.topic}\n\nBooking code: ${b.code}\nTo reschedule or cancel, chat with ${ownerName}'s booking assistant${reschedule} and give this code.`,
      start: { dateTime: b.start.toString(), timeZone: config.timeZone },
      end: { dateTime: b.end.toString(), timeZone: config.timeZone },
      attendees: [{ email: b.guestEmail, displayName: b.guestName }],
      conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } },
      extendedProperties: { private: { ...AGENT_TAG, bookingCode: b.code, guestName: b.guestName, guestEmail: b.guestEmail, topic: b.topic } },
    },
  });
  return toBooking(event)!;
}

async function moveBooking(id: string, start: Temporal.Instant, end: Temporal.Instant): Promise<Booking> {
  const event = await gcal<GEvent>("PATCH", `${cal()}/events/${encodeURIComponent(id)}`, {
    query: { sendUpdates: "all" },
    body: { start: { dateTime: start.toString(), timeZone: config.timeZone }, end: { dateTime: end.toString(), timeZone: config.timeZone } },
  });
  return toBooking(event)!;
}

async function cancelBooking(id: string): Promise<void> {
  await gcal<void>("DELETE", `${cal()}/events/${encodeURIComponent(id)}`, { query: { sendUpdates: "all" } });
}

/** The calendar's own name and time zone (events.list returns both, so no extra scope is needed). */
export async function calendarInfo(): Promise<{ summary: string; timeZone: string }> {
  return gcal("GET", `${cal()}/events`, { query: { maxResults: "1" } });
}

export const googleCalendar: Calendar = { busyBetween, agentBookingsBetween, findBookingByCode, createBooking, moveBooking, cancelBooking };
