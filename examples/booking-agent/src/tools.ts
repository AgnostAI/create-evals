import { tool } from "ai";
import { z } from "zod";
import { slotProblem, openSlots, without, type Rules } from "./availability.js";
import { config } from "./config.js";
import { agentBookingsBetween, busyBetween, cancelBooking, createBooking, findBookingByCode, moveBooking, type Booking } from "./google.js";

const rules: Rules = config;

const isTimeZone = (tz: string) => {
  try {
    Temporal.Now.zonedDateTimeISO(tz);
    return true;
  } catch {
    return false;
  }
};

const timeZone = z.string().refine(isTimeZone, "not an IANA time zone").describe("The guest's IANA time zone, e.g. Europe/Berlin. Times come back in this zone.");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD in the guest's time zone");
const startTime = z.string().describe("Exact start time with UTC offset, copied from find_open_times, e.g. 2026-11-03T15:30:00+01:00");
const duration = z
  .number()
  .int()
  .refine((m) => config.durations.includes(m), `must be one of ${config.durations.join(", ")}`)
  .describe(`Meeting length in minutes: ${config.durations.join(", ")}`);
const bookingCode = z.string().trim().regex(/^[A-Za-z0-9]{4,12}$/).describe("The booking code from the calendar invite");
const guestEmail = z.email().describe("The email the booking was made with");

/** How a time reads to the guest, plus the exact value to pass back to the booking tools. */
function show(t: Temporal.Instant, tz: string) {
  const z = t.toZonedDateTimeISO(tz);
  return {
    start: z.toString({ timeZoneName: "never", smallestUnit: "minute" }),
    label: z.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }),
  };
}

function parseStart(s: string): Temporal.Instant | undefined {
  try {
    return Temporal.Instant.from(s);
  } catch {
    return undefined;
  }
}

/** The owner's calendar day around `t`, for the per-day meeting cap. */
function ownerDay(t: Temporal.Instant) {
  const day = t.toZonedDateTimeISO(config.timeZone).startOfDay();
  return { from: day.toInstant(), to: day.add({ days: 1 }).toInstant() };
}

async function dayIsFull(t: Temporal.Instant, except?: string): Promise<boolean> {
  const { from, to } = ownerDay(t);
  const booked = await agentBookingsBetween(from, to);
  return booked.filter((b) => b.id !== except).length >= config.maxMeetingsPerDay;
}

/** Only the guest who made a booking (code + matching email) can see or change it. */
async function ownBooking(code: string, email: string): Promise<Booking | undefined> {
  const booking = await findBookingByCode(code.toUpperCase());
  if (!booking || booking.guestEmail.toLowerCase() !== email.trim().toLowerCase()) return undefined;
  return booking;
}

const NOT_FOUND = { found: false, reason: "No upcoming booking matches that code and email." };

function newCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (n) => alphabet[n % alphabet.length]).join("");
}

export const tools = {
  find_open_times: tool({
    description: `Find times when ${config.ownerName} is free to meet, between two dates (inclusive). Only returns slots that can actually be booked.`,
    inputSchema: z.object({ from_date: date, to_date: date, duration_minutes: duration, time_zone: timeZone }),
    execute: async ({ from_date, to_date, duration_minutes, time_zone }) => {
      const now = Temporal.Now.instant();
      const horizon = now.add({ hours: config.horizonDays * 24 });
      let from = Temporal.PlainDate.from(from_date).toZonedDateTime(time_zone).toInstant();
      let to = Temporal.PlainDate.from(to_date).add({ days: 1 }).toZonedDateTime(time_zone).toInstant();
      if (Temporal.Instant.compare(from, now) < 0) from = now;
      if (Temporal.Instant.compare(to, horizon) > 0) to = horizon;
      if (Temporal.Instant.compare(from, to) >= 0) return { days: [], note: `Nothing bookable in that range. Meetings can be booked from ${config.minNoticeMinutes / 60} hours to ${config.horizonDays} days ahead.` };

      const pad = { minutes: config.bufferMinutes };
      const busy = await busyBetween(from.subtract(pad), to.add(pad).add({ minutes: duration_minutes }));
      const slots = openSlots(from, to, duration_minutes, busy, now, rules);
      const days = new Map<string, { start: string; time: string }[]>();
      for (const s of slots.slice(0, 60)) {
        const z = s.toZonedDateTimeISO(time_zone);
        const day = z.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric" });
        const shown = show(s, time_zone);
        days.set(day, [...(days.get(day) ?? []), { start: shown.start, time: z.toLocaleString("en-US", { hour: "numeric", minute: "2-digit" }) }]);
      }
      return {
        time_zone,
        duration_minutes,
        days: [...days].map(([day, times]) => ({ day, times })),
        ...(slots.length > 60 ? { note: `Showing the first 60 of ${slots.length} open slots.` } : {}),
        ...(!slots.length ? { note: "No open times in that range." } : {}),
      };
    },
  }),

  book_meeting: tool({
    description: `Book a meeting on ${config.ownerName}'s calendar with a Google Meet link. Google emails the invite to the guest. Only call this after the guest has confirmed the exact time, length, name, email and topic.`,
    inputSchema: z.object({
      start: startTime,
      duration_minutes: duration,
      guest_name: z.string().trim().min(1).max(100),
      guest_email: z.email().describe("Where the invite goes"),
      topic: z.string().trim().min(1).max(500).describe("What the guest wants to talk about, in their words"),
      time_zone: timeZone,
    }),
    execute: async ({ start, duration_minutes, guest_name, guest_email, topic, time_zone }) => {
      const at = parseStart(start);
      if (!at) return { booked: false, reason: "start must be an exact time with a UTC offset, as returned by find_open_times." };
      const end = at.add({ minutes: duration_minutes });
      const busy = await busyBetween(at.subtract({ minutes: config.bufferMinutes }), end.add({ minutes: config.bufferMinutes }));
      const problem = slotProblem(at, duration_minutes, busy, Temporal.Now.instant(), rules);
      if (problem) return { booked: false, reason: `Can't book ${show(at, time_zone).label}: ${problem}.` };
      if (await dayIsFull(at)) return { booked: false, reason: `${config.ownerName} is fully booked that day. Try another day.` };

      const booking = await createBooking({ code: newCode(), guestName: guest_name, guestEmail: guest_email, topic, start: at, end }, config.ownerName);
      return {
        booked: true,
        booking_code: booking.code,
        when: show(at, time_zone).label,
        duration_minutes,
        meet_link: booking.meetLink ?? "in the calendar invite",
        invite_sent_to: guest_email,
      };
    },
  }),

  find_booking: tool({
    description: "Look up an existing booking. Needs the booking code from the invite and the email it was booked with.",
    inputSchema: z.object({ booking_code: bookingCode, guest_email: guestEmail, time_zone: timeZone }),
    execute: async ({ booking_code, guest_email, time_zone }) => {
      const b = await ownBooking(booking_code, guest_email);
      if (!b || Temporal.Instant.compare(b.start, Temporal.Now.instant()) < 0) return NOT_FOUND;
      return {
        found: true,
        when: show(b.start, time_zone).label,
        duration_minutes: b.start.until(b.end).total("minutes"),
        topic: b.topic,
        meet_link: b.meetLink,
      };
    },
  }),

  reschedule_booking: tool({
    description: "Move an existing booking to a new time. Needs the booking code and email. Google emails the guest the update.",
    inputSchema: z.object({ booking_code: bookingCode, guest_email: guestEmail, new_start: startTime, time_zone: timeZone }),
    execute: async ({ booking_code, guest_email, new_start, time_zone }) => {
      const b = await ownBooking(booking_code, guest_email);
      const now = Temporal.Now.instant();
      if (!b || Temporal.Instant.compare(b.start, now) < 0) return { rescheduled: false, ...NOT_FOUND };
      const at = parseStart(new_start);
      if (!at) return { rescheduled: false, reason: "new_start must be an exact time with a UTC offset, as returned by find_open_times." };
      const minutes = b.start.until(b.end).total("minutes");
      const end = at.add({ minutes });
      const busy = without(await busyBetween(at.subtract({ minutes: config.bufferMinutes }), end.add({ minutes: config.bufferMinutes })), b);
      const problem = slotProblem(at, minutes, busy, now, rules);
      if (problem) return { rescheduled: false, reason: `Can't move it to ${show(at, time_zone).label}: ${problem}.` };
      if (await dayIsFull(at, b.id)) return { rescheduled: false, reason: `${config.ownerName} is fully booked that day. Try another day.` };

      await moveBooking(b.id, at, end);
      return { rescheduled: true, from: show(b.start, time_zone).label, to: show(at, time_zone).label, duration_minutes: minutes };
    },
  }),

  cancel_booking: tool({
    description: "Cancel an existing booking. Needs the booking code and email. Google emails the guest the cancellation.",
    inputSchema: z.object({ booking_code: bookingCode, guest_email: guestEmail, time_zone: timeZone }),
    execute: async ({ booking_code, guest_email, time_zone }) => {
      const b = await ownBooking(booking_code, guest_email);
      if (!b || Temporal.Instant.compare(b.start, Temporal.Now.instant()) < 0) return { cancelled: false, ...NOT_FOUND };
      await cancelBooking(b.id);
      return { cancelled: true, was: show(b.start, time_zone).label };
    },
  }),
};
