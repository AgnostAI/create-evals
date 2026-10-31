// A fake in-memory calendar for one person. Nothing here talks to a real calendar.

export const OWNER = { name: "Priya Sharma", email: "priya@lumen.dev", timezone: "America/Los_Angeles" };

// The whole demo week (Nov 2–6, 2026) is after daylight saving ends, so Pacific time is UTC-8.
export const UTC_OFFSET = "-08:00";
export const WORK_HOURS = { start: "09:00", end: "17:00" };

// A fixed "now" so the agent behaves the same on every run.
export const NOW = `2026-11-02T08:30:00${UTC_OFFSET}`; // Monday morning

export interface CalendarEvent {
  id: string;
  title: string;
  start: string; // ISO with offset
  end: string;
  attendees: string[];
}

const at = (date: string, time: string) => `${date}T${time}:00${UTC_OFFSET}`;
const week = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"];

export const events: CalendarEvent[] = [
  ...week.map((d, i) => ({ id: `standup-${i + 1}`, title: "Team standup", start: at(d, "09:30"), end: at(d, "10:00"), attendees: ["team@lumen.dev"] })),
  { id: "evt-1", title: "Design review", start: at("2026-11-02", "13:00"), end: at("2026-11-02", "14:00"), attendees: ["sam@lumen.dev", "alex@lumen.dev"] },
  { id: "evt-2", title: "Customer call: Northwind", start: at("2026-11-03", "11:00"), end: at("2026-11-03", "12:30"), attendees: ["dana@northwind.com"] },
  { id: "evt-3", title: "1:1 with Sam", start: at("2026-11-03", "15:00"), end: at("2026-11-03", "16:00"), attendees: ["sam@lumen.dev"] },
  { id: "evt-4", title: "Planning offsite", start: at("2026-11-04", "10:00"), end: at("2026-11-04", "12:00"), attendees: ["team@lumen.dev"] },
  { id: "evt-5", title: "Focus time", start: at("2026-11-04", "14:00"), end: at("2026-11-04", "17:00"), attendees: [] },
  { id: "evt-6", title: "Lunch with Alex", start: at("2026-11-05", "12:00"), end: at("2026-11-05", "13:00"), attendees: ["alex@lumen.dev"] },
  { id: "evt-7", title: "Interview: backend candidate", start: at("2026-11-05", "16:00"), end: at("2026-11-05", "16:30"), attendees: ["recruiting@lumen.dev"] },
  { id: "evt-8", title: "Team social", start: at("2026-11-06", "15:00"), end: at("2026-11-06", "17:00"), attendees: ["team@lumen.dev"] },
];

const ms = (iso: string) => new Date(iso).getTime();

/** Local ISO string (with the Pacific offset) for a timestamp. */
function toLocal(t: number): string {
  const d = new Date(t + parseOffsetMinutes(UTC_OFFSET) * 60_000);
  return d.toISOString().slice(0, 16) + `:00${UTC_OFFSET}`;
}

function parseOffsetMinutes(offset: string): number {
  const [h, m] = offset.slice(1).split(":").map(Number);
  return (offset[0] === "-" ? -1 : 1) * (h! * 60 + m!);
}

function daysBetween(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  for (let t = ms(at(startDate, "12:00")); t <= ms(at(endDate, "12:00")); t += 86_400_000) out.push(toLocal(t).slice(0, 10));
  return out;
}

const isWeekend = (date: string) => [0, 6].includes(new Date(at(date, "12:00")).getUTCDay());

/** Events overlapping [startDate, endDate] (inclusive, YYYY-MM-DD, local time), earliest first. */
export function listEvents(startDate: string, endDate: string): CalendarEvent[] {
  const from = ms(at(startDate, "00:00"));
  const to = ms(at(endDate, "23:59"));
  return events.filter((e) => ms(e.end) > from && ms(e.start) < to).sort((a, b) => ms(a.start) - ms(b.start));
}

/** Gaps of at least `minutes` inside working hours on weekdays between two dates. */
export function freeSlots(startDate: string, endDate: string, minutes: number): { start: string; end: string; minutes: number }[] {
  const slots: { start: string; end: string; minutes: number }[] = [];
  for (const day of daysBetween(startDate, endDate)) {
    if (isWeekend(day)) continue;
    let cursor = Math.max(ms(at(day, WORK_HOURS.start)), ms(NOW));
    const close = ms(at(day, WORK_HOURS.end));
    for (const e of listEvents(day, day)) {
      if (ms(e.start) - cursor >= minutes * 60_000) slots.push({ start: toLocal(cursor), end: e.start, minutes: (ms(e.start) - cursor) / 60_000 });
      cursor = Math.max(cursor, ms(e.end));
    }
    if (close - cursor >= minutes * 60_000) slots.push({ start: toLocal(cursor), end: toLocal(close), minutes: (close - cursor) / 60_000 });
  }
  return slots;
}
