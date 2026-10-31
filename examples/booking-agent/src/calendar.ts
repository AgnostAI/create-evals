import type { Interval } from "./availability.js";

/** A meeting this agent booked. Stored on the event, so it can find (only) its own bookings later. */
export interface Booking {
  id: string;
  code: string;
  guestName: string;
  guestEmail: string;
  topic: string;
  start: Temporal.Instant;
  end: Temporal.Instant;
  meetLink?: string;
}

export type NewBooking = Omit<Booking, "id" | "meetLink">;

/** What the tools need from a calendar. Google Calendar in production (src/google.ts). */
export interface Calendar {
  /** Busy blocks on the owner's calendars. Titles never reach the agent. */
  busyBetween(from: Temporal.Instant, to: Temporal.Instant): Promise<Interval[]>;
  /** Meetings this agent booked that start inside [from, to). */
  agentBookingsBetween(from: Temporal.Instant, to: Temporal.Instant): Promise<Booking[]>;
  findBookingByCode(code: string): Promise<Booking | undefined>;
  /** Creates the event and invites the guest. */
  createBooking(b: NewBooking): Promise<Booking>;
  /** Moves the event and emails the guest the update. */
  moveBooking(id: string, start: Temporal.Instant, end: Temporal.Instant): Promise<Booking>;
  /** Deletes the event and emails the guest the cancellation. */
  cancelBooking(id: string): Promise<void>;
}
