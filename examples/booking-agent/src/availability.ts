// Pure time math: which slots are bookable, and why a given slot isn't. No I/O, so it's easy to test.

export interface Interval {
  start: Temporal.Instant;
  end: Temporal.Instant;
}

export interface Rules {
  timeZone: string;
  workdays: number[];
  dayStart: Temporal.PlainTime;
  dayEnd: Temporal.PlainTime;
  bufferMinutes: number;
  minNoticeMinutes: number;
  horizonDays: number;
}

const before = (a: Temporal.Instant, b: Temporal.Instant) => Temporal.Instant.compare(a, b) < 0;
const overlaps = (a: Interval, b: Interval) => before(a.start, b.end) && before(b.start, a.end);

/** Why `start` can't be booked for `minutes`, or undefined if it can. */
export function slotProblem(start: Temporal.Instant, minutes: number, busy: Interval[], now: Temporal.Instant, rules: Rules): string | undefined {
  const end = start.add({ minutes });
  const local = start.toZonedDateTimeISO(rules.timeZone);
  const localEnd = end.toZonedDateTimeISO(rules.timeZone);
  if (before(start, now.add({ minutes: rules.minNoticeMinutes }))) return `needs at least ${rules.minNoticeMinutes / 60} hours' notice`;
  if (before(now.add({ hours: rules.horizonDays * 24 }), start)) return `can only be booked up to ${rules.horizonDays} days ahead`;
  if (!rules.workdays.includes(local.dayOfWeek)) return "not a working day";
  if (local.minute % 15 || local.second) return "must start on the hour, :15, :30 or :45";
  const startsTooEarly = Temporal.PlainTime.compare(local.toPlainTime(), rules.dayStart) < 0;
  const endsTooLate = !localEnd.toPlainDate().equals(local.toPlainDate()) || Temporal.PlainTime.compare(localEnd.toPlainTime(), rules.dayEnd) > 0;
  if (startsTooEarly || endsTooLate) return `outside working hours (${rules.dayStart.toString().slice(0, 5)}–${rules.dayEnd.toString().slice(0, 5)} ${rules.timeZone})`;
  const padded = { start: start.subtract({ minutes: rules.bufferMinutes }), end: end.add({ minutes: rules.bufferMinutes }) };
  if (busy.some((b) => overlaps(b, padded))) return "that time is already taken";
  return undefined;
}

/** Bookable start times inside [from, to), on a `step`-minute grid in the owner's time zone. */
export function openSlots(from: Temporal.Instant, to: Temporal.Instant, minutes: number, busy: Interval[], now: Temporal.Instant, rules: Rules, step = 30): Temporal.Instant[] {
  const slots: Temporal.Instant[] = [];
  let day = from.toZonedDateTimeISO(rules.timeZone).toPlainDate();
  const lastDay = to.toZonedDateTimeISO(rules.timeZone).toPlainDate();
  for (; Temporal.PlainDate.compare(day, lastDay) <= 0; day = day.add({ days: 1 })) {
    let t = day.toZonedDateTime({ timeZone: rules.timeZone, plainTime: rules.dayStart }).toInstant();
    const close = day.toZonedDateTime({ timeZone: rules.timeZone, plainTime: rules.dayEnd }).toInstant();
    for (; !before(close, t.add({ minutes })); t = t.add({ minutes: step })) {
      if (before(t, from) || !before(t, to)) continue;
      if (!slotProblem(t, minutes, busy, now, rules)) slots.push(t);
    }
  }
  return slots;
}

/** Busy time minus one interval: used when moving a meeting, so it doesn't collide with itself. */
export function without(busy: Interval[], own: Interval): Interval[] {
  return busy.flatMap((b) => {
    if (!overlaps(b, own)) return [b];
    const parts: Interval[] = [];
    if (before(b.start, own.start)) parts.push({ start: b.start, end: own.start });
    if (before(own.end, b.end)) parts.push({ start: own.end, end: b.end });
    return parts;
  });
}
