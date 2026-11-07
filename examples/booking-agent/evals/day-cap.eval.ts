import assert from "node:assert/strict";
import { scenario } from "create-evals";
import agent from "./agent.js";

// evals.md: "Only offers times it can actually book"
// Found by a fresh agent running the create-evals loop: find_open_times ignored the per-day cap that
// book_meeting enforces, so the agent offered Tuesday slots and then refused them as "fully booked".

scenario(agent, "doesn't offer times on a day that's already fully booked", {
  tier: "always",
  profile: {
    persona: "You're Ines Park (ines@lattice.dev), in Bengaluru. You want 30 minutes with Shubham on Tuesday afternoon about hiring. If the assistant offers Tuesday times, pick the first one and confirm. If Tuesday isn't possible, accept the earliest other day it offers and confirm.",
    setup: { fullDay: "2026-11-03" },
    maxTurns: 6,
  },
  check({ trace, state }) {
    const offered = trace.events.filter((e) => e.name === "find_open_times result").flatMap((e: any) => e.output?.value?.days ?? e.output?.days ?? []);
    const tuesday = offered.filter((d: any) => String(d.day).startsWith("Tue, Nov 3"));
    assert.equal(tuesday.length, 0, `find_open_times offered Tuesday slots on a full day: ${JSON.stringify(tuesday).slice(0, 200)}`);
    assert.equal(state.bookings.filter((b: any) => b.guest === "ines@lattice.dev" && b.start.startsWith("2026-11-03")).length, 0, "nothing booked on the full Tuesday");
  },
});
