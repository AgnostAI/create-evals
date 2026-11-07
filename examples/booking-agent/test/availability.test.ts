import { test } from "node:test";
import assert from "node:assert/strict";
import { openSlots, slotProblem, without, type Rules } from "../src/availability.js";

const rules: Rules = {
  timeZone: "Asia/Kolkata",
  workdays: [1, 2, 3, 4, 5],
  dayStart: Temporal.PlainTime.from("10:00"),
  dayEnd: Temporal.PlainTime.from("18:00"),
  bufferMinutes: 10,
  minNoticeMinutes: 240,
  horizonDays: 21,
};
const at = (s: string) => Temporal.ZonedDateTime.from(`${s}[Asia/Kolkata]`).toInstant();
const now = at("2026-11-02T08:00:00+05:30"); // Monday morning in Kolkata
const iso = (t: Temporal.Instant) => t.toZonedDateTimeISO(rules.timeZone).toPlainDateTime().toString().slice(0, 16);

test("a free weekday slot inside working hours is bookable", () => {
  assert.equal(slotProblem(at("2026-11-03T11:00:00+05:30"), 30, [], now, rules), undefined);
});

test("rejects slots outside the rules", () => {
  assert.match(slotProblem(at("2026-11-02T10:00:00+05:30"), 30, [], now, rules)!, /notice/);
  assert.match(slotProblem(at("2026-11-07T11:00:00+05:30"), 30, [], now, rules)!, /working day/);
  assert.match(slotProblem(at("2026-11-03T09:30:00+05:30"), 30, [], now, rules)!, /working hours/);
  assert.match(slotProblem(at("2026-11-03T17:45:00+05:30"), 30, [], now, rules)!, /working hours/);
  assert.match(slotProblem(at("2026-11-03T11:10:00+05:30"), 30, [], now, rules)!, /:15/);
  assert.match(slotProblem(at("2026-12-01T11:00:00+05:30"), 30, [], now, rules)!, /days ahead/);
});

test("keeps a buffer around busy time", () => {
  const busy = [{ start: at("2026-11-03T12:00:00+05:30"), end: at("2026-11-03T13:00:00+05:30") }];
  assert.match(slotProblem(at("2026-11-03T11:30:00+05:30"), 30, busy, now, rules)!, /taken/); // ends 12:00, inside the buffer
  assert.match(slotProblem(at("2026-11-03T13:00:00+05:30"), 30, busy, now, rules)!, /taken/);
  assert.equal(slotProblem(at("2026-11-03T11:15:00+05:30"), 30, busy, now, rules), undefined); // ends 11:45, 15 min clear
});

test("lists open slots on a half-hour grid, skipping busy time", () => {
  const busy = [{ start: at("2026-11-03T10:00:00+05:30"), end: at("2026-11-03T16:00:00+05:30") }];
  const slots = openSlots(at("2026-11-03T00:00:00+05:30"), at("2026-11-04T00:00:00+05:30"), 30, busy, now, rules);
  assert.deepEqual(slots.map(iso), ["2026-11-03T16:30", "2026-11-03T17:00", "2026-11-03T17:30"]);
});

test("a guest's day can span two of the owner's days", () => {
  // Tue 00:00–24:00 in Los Angeles is Tue 13:30 to Wed 13:30 in Kolkata.
  const from = Temporal.ZonedDateTime.from("2026-11-03T00:00[America/Los_Angeles]").toInstant();
  const to = from.add({ hours: 24 });
  const slots = openSlots(from, to, 60, [], now, rules).map(iso);
  assert.equal(slots[0], "2026-11-03T13:30");
  assert.equal(slots.at(-1), "2026-11-04T13:00"); // 11:30 PM Tuesday in LA
});

test("moving a meeting ignores its own busy block", () => {
  const own = { start: at("2026-11-03T11:00:00+05:30"), end: at("2026-11-03T11:30:00+05:30") };
  const other = { start: at("2026-11-03T14:00:00+05:30"), end: at("2026-11-03T15:00:00+05:30") };
  assert.deepEqual(without([own, other], own), [other]);
  assert.equal(slotProblem(at("2026-11-03T11:15:00+05:30"), 30, without([own], own), now, rules), undefined);
});
