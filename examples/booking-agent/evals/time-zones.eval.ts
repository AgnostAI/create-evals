import assert from "node:assert/strict";
import { scenario } from "create-evals";
import agent from "./agent.js";
import { local, mentionsTime } from "./helpers.js";
import { at } from "./seed.js";

// evals.md: "Offers and books times in the guest's time zone, and says the time it booked"

scenario(agent, "Berlin guest gets the one afternoon slot that works, stated in Berlin time", {
  profile: {
    persona: "You're Lena Vogel (lena@kiteworks.example), in Berlin. You want 30 minutes with Shubham on Tuesday afternoon (your time) to talk about integrating Agnost into Kiteworks. Accept a time that's in the afternoon your time. Confirm when the assistant summarizes the details correctly.",
    setup: { timeZone: "Europe/Berlin" },
  },
  check({ state, said }) {
    const mine = state.bookings.filter((b: any) => b.guest === "lena@kiteworks.example");
    assert.equal(mine.length, 1, "exactly one booking for Lena");
    assert.equal(mine[0].start, at("2026-11-03T17:30").toString(), "Tue 13:00 Berlin (17:30 IST) is the only 30-minute afternoon slot");
    assert.ok(mentionsTime(said, mine[0].start, "Europe/Berlin"), "told Lena the booked time in Berlin time (1:00 PM)");
    assert.ok(said.includes(mine[0].code), "gave Lena her booking code");
  },
});

scenario(agent, "New York guest asking for 3pm (1:30 AM for Shubham) gets a real slot, stated in New York time", {
  profile: {
    persona: "You're Marcus Reed (marcus@tallypay.example), in New York. You want 30 minutes with Shubham about a payments partnership. Ask for Tuesday at 3pm. If that doesn't work, say you can do any time from 7:00 AM your time onward, and ask for the earliest such slot this week. Accept it and confirm when the details are summarized.",
    setup: { timeZone: "America/New_York" },
  },
  check({ state, said }) {
    const mine = state.bookings.filter((b: any) => b.guest === "marcus@tallypay.example");
    assert.equal(mine.length, 1, "exactly one booking for Marcus");
    const ny = local(mine[0].start, "America/New_York");
    assert.ok(ny.hour >= 7 && ny.hour !== 15, `booked at ${ny.toPlainTime()} New York time; Marcus asked for 7:00 AM or later`);
    assert.ok(mentionsTime(said, mine[0].start, "America/New_York"), "told Marcus the booked time in New York time");
  },
});

scenario(agent, "with 2 hours' notice, books no earlier than the 4-hour minimum", {
  profile: {
    persona: "You're Kabir Shah (kabir@ledgerly.example), in Bengaluru. It's urgent: ask for 15 minutes with Shubham today at 11am about a production incident at Ledgerly. If 11 isn't possible, take the earliest time today the assistant offers and confirm it.",
  },
  check({ state, said }) {
    const mine = state.bookings.filter((b: any) => b.guest === "kabir@ledgerly.example");
    assert.equal(mine.length, 1, "one booking for Kabir");
    assert.ok(Temporal.Instant.compare(Temporal.Instant.from(mine[0].start), at("2026-11-02T13:00")) >= 0, "no earlier than 1:00 PM (4 hours after 9:00 AM)");
    assert.ok(mentionsTime(said, mine[0].start, "Asia/Kolkata"), "told Kabir the booked time");
  },
});
