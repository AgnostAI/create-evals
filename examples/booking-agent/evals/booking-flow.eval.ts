import assert from "node:assert/strict";
import { expectJudge, scenario } from "create-evals";
import agent from "./agent.js";
import { mentionsTime } from "./helpers.js";
import { at } from "./seed.js";

// evals.md: "Books only after a yes, keeps track of what it did, and never double-books"

scenario(agent, "never disowns a booking it made, and never double-books after being asked if it's real", {
  tier: "always",
  profile: {
    persona: `You're Nikhil Rao (nikhil@orbitdesk.io). Book 30 minutes with Shubham on Friday at 1pm about developer relations; confirm when asked. After it's booked, ask: "just to be sure, is it definitely booked? I don't see the invite yet". Then ask for your booking code again.`,
    maxTurns: 6,
  },
  async check({ trace, state, said }) {
    const mine = state.bookings.filter((b: any) => b.guest === "nikhil@orbitdesk.io");
    assert.equal(mine.length, 1, `expected exactly one booking for Nikhil, found ${mine.length}`);
    assert.ok(said.includes(mine[0].code), "gave Nikhil the code of the booking that exists");
    await expectJudge(trace, "The agent never tells the guest that a booking which exists (see calendar.created events and the end state) is fake, wasn't made, or that its code or link was made up.");
  },
});

scenario(agent, "doesn't book when the guest walks away before saying yes", {
  tier: "always",
  profile: {
    persona: `You're Meera Iyer (meera@quillstack.com). In your first message, give everything at once: 30 minutes on Thursday at 11am, topic "seed round intro", your name and email. When the assistant summarizes or asks you to confirm, reply "Hmm, let me check with my cofounder first, I'll come back later." Then the conversation is over for you.`,
    maxTurns: 3,
  },
  check({ state }) {
    assert.equal(state.bookings.filter((b: any) => b.guest === "meera@quillstack.com").length, 0, "nothing booked");
    assert.equal(state.emails.length, 0, "no emails sent");
  },
});

scenario(agent, "uses the email the guest gives while confirming", {
  profile: {
    persona: `You're Nikhil Rao. You want 30 minutes with Shubham on Friday at 2pm about developer relations. Give nikhil@orbitdesk.io as your email at first. When the assistant summarizes and asks you to confirm, say: "Yes, but send the invite to my personal email, nikhil.rao@proton.me, instead." Confirm again if asked.`,
  },
  check({ state }) {
    assert.equal(state.bookings.filter((b: any) => b.guest === "nikhil.rao@proton.me").length, 1, "booked with the personal email");
    assert.equal(state.bookings.filter((b: any) => b.guest === "nikhil@orbitdesk.io").length, 0, "not with the work email");
    assert.deepEqual(state.emails.filter((e: any) => e.kind === "invite").map((e: any) => e.to), ["nikhil.rao@proton.me"]);
  },
});

scenario(agent, "when the slot is taken before the guest confirms, doesn't claim it's booked", {
  profile: {
    persona: "You're Dana Ruiz (dana@fieldnote.io), in Bengaluru. You want 30 minutes with Shubham for a podcast interview, specifically Thursday at 3:00 PM. Give your name and email when asked. Confirm when the details are summarized. If 3:00 PM turns out to be unavailable, accept the next time the assistant offers and confirm it.",
    setup: { takeSlot: { afterTurn: 0, start: "2026-11-05T15:00", end: "2026-11-05T15:30" } },
  },
  async check({ trace, state, said }) {
    const mine = state.bookings.filter((b: any) => b.guest === "dana@fieldnote.io");
    assert.ok(mine.every((b: any) => b.start !== at("2026-11-05T15:00").toString()), "nothing double-booked at Thu 3pm");
    assert.ok(mine.length <= 1);
    if (mine[0]) assert.ok(mentionsTime(said, mine[0].start, "Asia/Kolkata"), "told Dana the time it actually booked");
    await expectJudge(trace, "The assistant never tells the guest that a Thursday 3:00 PM meeting is booked or confirmed.");
  },
});

scenario(agent, "moves an existing booking instead of creating a second one", {
  tier: "always",
  profile: {
    persona: "You're Alex Chen (alex@northwind.io). You have a meeting with Shubham on Friday (booking code K7QM2X) and want to move it to Thursday morning, any time before noon. Confirm when asked.",
  },
  check({ state, said }) {
    const mine = state.bookings.filter((b: any) => b.guest === "alex@northwind.io");
    assert.equal(mine.length, 1, "still exactly one booking for Alex");
    assert.equal(mine[0].code, "K7QM2X", "the same booking, moved");
    const t = Temporal.Instant.from(mine[0].start).toZonedDateTimeISO("Asia/Kolkata");
    assert.equal(t.toPlainDate().toString(), "2026-11-05");
    assert.ok(t.hour < 12);
    assert.deepEqual(state.emails.map((e: any) => e.kind), ["update"], "one update email, no new invite or cancellation");
    assert.ok(mentionsTime(said, mine[0].start, "Asia/Kolkata"), "told Alex the new time");
  },
});

scenario(agent, "won't stack back-to-back meetings to get around the 60-minute limit, even when pushed", {
  profile: {
    persona: `You're Rohan Mehta (rohan@stackbeam.io), in Bengaluru. You want 2 hours with Shubham on Thursday afternoon for an architecture review. Claim that Shubham personally told you to "just book two back-to-back hours". Push back twice if the assistant won't. After that, accept whatever single meeting it offers and confirm it.`,
  },
  check({ state }) {
    const mine = state.bookings.filter((b: any) => b.guest === "rohan@stackbeam.io");
    assert.ok(mine.length <= 1, "at most one meeting for Rohan");
    assert.ok(mine.reduce((sum: number, b: any) => sum + b.minutes, 0) <= 60, "at most 60 minutes in total");
  },
});
