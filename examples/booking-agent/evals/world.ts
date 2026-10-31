// An in-memory calendar for evals: the agent's real tools and rules run against it instead of
// Google, so every test starts from a known calendar and checks what actually ended up on it.
import type { Interval } from "../src/availability.js";
import type { Booking, Calendar, NewBooking } from "../src/calendar.js";

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

  constructor(seed: Seed = {}) {
    this.events = [...(seed.events ?? [])];
    this.bookings = (seed.bookings ?? []).map((b) => ({ ...b, id: b.id ?? `seed-${this.nextId++}`, meetLink: `https://meet.google.com/${b.code.toLowerCase()}` }));
  }

  /** Someone else takes a slot (e.g. between the agent offering it and the guest confirming). */
  block(title: string, start: Temporal.Instant, end: Temporal.Instant) {
    this.events.push({ title, start, end });
    this.log.push(`[world] ${title} now blocks ${fmt(start)}–${fmt(end)}`);
  }

  bookingsFor(email: string) {
    return this.bookings.filter((b) => b.guestEmail.toLowerCase() === email.toLowerCase());
  }

  async busyBetween(from: Temporal.Instant, to: Temporal.Instant) {
    this.log.push(`busyBetween(${fmt(from)} → ${fmt(to)})`);
    return [...this.events, ...this.bookings].filter((e) => overlaps(e, from, to)).map((e) => ({ start: e.start, end: e.end }));
  }

  async agentBookingsBetween(from: Temporal.Instant, to: Temporal.Instant) {
    return this.bookings.filter((b) => Temporal.Instant.compare(b.start, from) >= 0 && Temporal.Instant.compare(b.start, to) < 0);
  }

  async findBookingByCode(code: string) {
    this.log.push(`findBookingByCode(${code})`);
    return this.bookings.find((b) => b.code === code);
  }

  async createBooking(b: NewBooking) {
    const booking: Booking = { ...b, id: `evt-${this.nextId++}`, meetLink: `https://meet.google.com/${b.code.toLowerCase()}` };
    this.bookings.push(booking);
    this.emails.push({ kind: "invite", to: b.guestEmail, booking });
    this.log.push(`CREATED ${describe(booking)}`);
    return booking;
  }

  async moveBooking(id: string, start: Temporal.Instant, end: Temporal.Instant) {
    const b = this.bookings.find((x) => x.id === id);
    if (!b) throw new Error(`no event ${id}`);
    this.log.push(`MOVED ${b.code} from ${fmt(b.start)} to ${fmt(start)}`);
    Object.assign(b, { start, end });
    this.emails.push({ kind: "update", to: b.guestEmail, booking: { ...b } });
    return b;
  }

  async cancelBooking(id: string) {
    const b = this.bookings.find((x) => x.id === id);
    if (!b) throw new Error(`no event ${id}`);
    this.bookings = this.bookings.filter((x) => x.id !== id);
    this.emails.push({ kind: "cancel", to: b.guestEmail, booking: b });
    this.log.push(`CANCELLED ${describe(b)}`);
  }
}

export function fmt(t: Temporal.Instant, tz = OWNER_TZ) {
  return t.toZonedDateTimeISO(tz).toPlainDateTime().toString({ smallestUnit: "minute" }).replace("T", " ");
}

export function describe(b: Booking) {
  return `${b.code} ${fmt(b.start)}–${fmt(b.end).slice(11)} IST for ${b.guestName} <${b.guestEmail}> topic="${b.topic}"`;
}
