import type { Seed } from "./world.js";

export const IST = "Asia/Kolkata";
export const at = (local: string, tz = IST) => Temporal.ZonedDateTime.from(`${local}[${tz}]`).toInstant();

/** Four agent bookings on one day: the per-day cap (MAX_MEETINGS_PER_DAY = 4) is reached. */
const fullDay = (date: string) =>
  ["10:00", "11:00", "14:00", "15:00"].map((t, i) => ({
    code: `FULL${i}A`,
    guestName: `Guest ${i}`,
    guestEmail: `guest${i}@example.com`,
    topic: "Intro call",
    start: at(`${date}T${t}`),
    end: at(`${date}T${t}`).add({ minutes: 30 }),
  }));

/** Shubham's week (from Monday Nov 2, 9:00 AM IST). The agent only ever sees these as busy blocks. */
export const week = (opts: { fullDay?: string } = {}): Seed => ({
  events: [
    { title: "Standup", start: at("2026-11-02T10:00"), end: at("2026-11-02T10:30") },
    { title: "Investor call: Lightspeed", start: at("2026-11-02T14:00"), end: at("2026-11-02T15:30") },
    { title: "Hiring loop: backend", start: at("2026-11-03T10:00"), end: at("2026-11-03T12:00") },
    { title: "1:1 with Rahul", start: at("2026-11-03T16:00"), end: at("2026-11-03T17:00") },
    { title: "Offsite (Goa)", start: at("2026-11-04T10:00"), end: at("2026-11-04T18:00") },
    { title: "Lunch with Meera", start: at("2026-11-05T12:00"), end: at("2026-11-05T13:00") },
    { title: "Standup", start: at("2026-11-06T10:00"), end: at("2026-11-06T10:30") },
    { title: "Board prep", start: at("2026-11-06T15:00"), end: at("2026-11-06T18:00") },
  ],
  bookings: [
    { code: "PRY4KQ", guestName: "Priya Nair", guestEmail: "priya@lumen.dev", topic: "Eval setup review for Lumen", start: at("2026-11-05T16:00"), end: at("2026-11-05T16:30") },
    { code: "K7QM2X", guestName: "Alex Chen", guestEmail: "alex@northwind.io", topic: "Using create-evals at Northwind", start: at("2026-11-06T11:00"), end: at("2026-11-06T11:30") },
    ...(opts.fullDay ? fullDay(opts.fullDay) : []),
  ],
});
