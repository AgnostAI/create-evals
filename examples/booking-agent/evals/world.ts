// An in-memory calendar for evals: the agent's real tools and rules run against it instead of
// Google, so every test starts from a known calendar and checks what actually ended up on it.
import type { Interval } from "../src/availability.js";
import type { Booking, Calendar, NewBooking } from "../src/calendar.js";
import type { Context } from "create-evals";

export const OWNER_TZ = "Asia/Kolkata";

/** "2026-11-03T17:30" in a zone (default: the owner's) → Instant. */
export const at = (local: string, tz = OWNER_TZ) => Temporal.ZonedDateTime.from(`${local}[${tz}]`).toInstant();

/** One of the owner's own events. The agent must only ever see it as "busy". */
export interface PrivateEvent {
  title: string;
  start: Temporal.Instant;
  end: Temporal.Instant;
}

export interface Email {
  kind: "invite" | "update" | "cancel";
  to: string;
  booking: Booking;
}

export interface Seed {
  events?: PrivateEvent[];
  bookings?: (NewBooking & { id?: string })[];
}

const overlaps = (a: Interval, from: Temporal.Instant, to: Temporal.Instant) =>
  Temporal.Instant.compare(a.start, to) < 0 && Temporal.Instant.compare(from, a.end) < 0;

export class World implements Calendar {
  events: PrivateEvent[];
  bookings: Booking[];
  emails: Email[] = [];
  /** Every calendar operation, for failure messages. */
  log: string[] = [];
  private nextId = 1;

  /** `record` sends each calendar operation to the conversation trace, so reviews can check said vs did. */
  constructor(seed: Seed = {}, private record?: Context["record"]) {
    this.events = [...(seed.events ?? [])];
    this.bookings = (seed.bookings ?? []).map((b) => ({ ...b, id: b.id ?? `seed-${this.nextId++}`, meetLink: `https://meet.google.com/${b.code.toLowerCase()}` }));
  }

  /** Someone else takes a slot (e.g. between the agent offering it and the guest confirming). */
  block(title: string, start: Temporal.Instant, end: Temporal.Instant) {
    this.events.push({ title, start, end });
    this.note("note", "someone else booked", `${title}: ${fmt(start)}–${fmt(end)}`);
  }

  private note(kind: "tool" | "state" | "note", name: string, detail: string) {
    this.log.push(`${name} ${detail}`);
    this.record?.({ kind, name, input: detail });
  }

  /** Plain data for traces and tests. */
  snapshot() {
    return {
      bookings: this.bookings.map((b) => ({ code: b.code, guest: b.guestEmail, name: b.guestName, topic: b.topic, start: b.start.toString(), minutes: b.start.until(b.end).total("minutes") })),
      emails: this.emails.map((e) => ({ kind: e.kind, to: e.to, code: e.booking.code })),
    };
  }

  bookingsFor(email: string) {
    return this.bookings.filter((b) => b.guestEmail.toLowerCase() === email.toLowerCase());
  }

  async busyBetween(from: Temporal.Instant, to: Temporal.Instant) {
    this.note("tool", "calendar.freeBusy", `${fmt(from)} → ${fmt(to)}`);
    return [...this.events, ...this.bookings].filter((e) => overlaps(e, from, to)).map((e) => ({ start: e.start, end: e.end }));
  }

  async agentBookingsBetween(from: Temporal.Instant, to: Temporal.Instant) {
    return this.bookings.filter((b) => Temporal.Instant.compare(b.start, from) >= 0 && Temporal.Instant.compare(b.start, to) < 0);
  }

  async findBookingByCode(code: string) {
    this.note("tool", "calendar.findByCode", code);
    return this.bookings.find((b) => b.code === code);
  }

  async createBooking(b: NewBooking) {
    const booking: Booking = { ...b, id: `evt-${this.nextId++}`, meetLink: `https://meet.google.com/${b.code.toLowerCase()}` };
    this.bookings.push(booking);
    this.emails.push({ kind: "invite", to: b.guestEmail, booking });
    this.note("state", "calendar.created", describe(booking));
    return booking;
  }

  async moveBooking(id: string, start: Temporal.Instant, end: Temporal.Instant) {
    const b = this.bookings.find((x) => x.id === id);
    if (!b) throw new Error(`no event ${id}`);
    this.note("state", "calendar.moved", `${b.code} from ${fmt(b.start)} to ${fmt(start)}`);
    Object.assign(b, { start, end });
    this.emails.push({ kind: "update", to: b.guestEmail, booking: { ...b } });
    return b;
  }

  async cancelBooking(id: string) {
    const b = this.bookings.find((x) => x.id === id);
    if (!b) throw new Error(`no event ${id}`);
    this.bookings = this.bookings.filter((x) => x.id !== id);
    this.emails.push({ kind: "cancel", to: b.guestEmail, booking: b });
    this.note("state", "calendar.cancelled", describe(b));
  }
}

export function fmt(t: Temporal.Instant, tz = OWNER_TZ) {
  return t.toZonedDateTimeISO(tz).toPlainDateTime().toString({ smallestUnit: "minute" }).replace("T", " ");
}

export function describe(b: Booking) {
  return `${b.code} ${fmt(b.start)}–${fmt(b.end).slice(11)} IST for ${b.guestName} <${b.guestEmail}> topic="${b.topic}"`;
}
