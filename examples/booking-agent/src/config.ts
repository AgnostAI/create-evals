import "./env.js";

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

/** Booking rules. Everything is overridable from .env; the defaults are what the README describes. */
export const config = {
  ownerName: process.env.OWNER_NAME ?? "Shubham",
  /** The calendar meetings are booked on. */
  calendarId: process.env.CALENDAR_ID ?? "primary",
  /** Extra calendars that also block time (e.g. a personal calendar shared with this account). */
  busyCalendars: list(process.env.BUSY_CALENDARS ?? ""),
  /** Written by `npm run auth` from the calendar's own setting. */
  timeZone: process.env.OWNER_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  /** ISO weekday numbers: 1 = Monday ... 7 = Sunday. */
  workdays: list(process.env.WORKDAYS ?? "1,2,3,4,5").map(Number),
  dayStart: Temporal.PlainTime.from(process.env.DAY_START ?? "10:00"),
  dayEnd: Temporal.PlainTime.from(process.env.DAY_END ?? "18:00"),
  durations: list(process.env.DURATIONS ?? "15,30,45,60").map(Number),
  bufferMinutes: num("BUFFER_MINUTES", 10),
  minNoticeMinutes: num("MIN_NOTICE_HOURS", 4) * 60,
  horizonDays: num("HORIZON_DAYS", 21),
  maxMeetingsPerDay: num("MAX_MEETINGS_PER_DAY", 4),
  /** Where guests reach the agent; goes into invites so they know where to reschedule. */
  publicUrl: process.env.PUBLIC_URL ?? "",
};

export type Config = typeof config;
