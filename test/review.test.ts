import { afterEach, describe, expect, it } from "vitest";
import { grounded, group, review } from "../src/review.js";
import { fakeModel } from "./helpers.js";

let restore = () => {};
afterEach(() => restore());

const trace: any = {
  id: "t1",
  profile: { id: "p", persona: "guest" },
  turns: [{ role: "user", text: "is it booked?" }, { role: "agent", text: "No, I never booked it, the code was made up." }],
  events: [{ turn: 0, kind: "state", name: "calendar.created", input: "ABC123" }],
};

describe("review", () => {
  it("keeps problems whose evidence is in the transcript and drops invented ones", async () => {
    const m = fakeModel([
      {
        problems: [
          { turn: 0, what: "Denies a real booking", evidence: "I never booked it, the code was made up", severity: "high" },
          { turn: 0, what: "Invented", evidence: "this text is nowhere in the transcript", severity: "high" },
        ],
        simulator_issues: [],
        summary: "denied a booking",
      },
    ]);
    restore = m.restore;
    const r = await review(trace, { description: "booking agent", instructions: "never lie" }, "claude-test");
    expect(r.problems.map((p) => p.what)).toEqual(["Denies a real booking"]);
    expect(m.calls[0].body.messages[0].content).toContain("[state] calendar.created");
    expect(m.calls[0].body.output_config.format.type).toBe("json_schema");
  });
});

describe("group", () => {
  it("maps note ids back to traces and orders modes by how many traces they hit", async () => {
    const traces: any[] = [
      { ...trace, id: "a", review: { problems: [{ turn: 0, what: "x", evidence: "e", severity: "low" }] } },
      { ...trace, id: "b", review: { problems: [{ turn: 1, what: "y", evidence: "e", severity: "high" }] } },
      { ...trace, id: "c", review: { problems: [{ turn: 0, what: "y2", evidence: "e", severity: "high" }] } },
    ];
    const m = fakeModel([
      {
        modes: [
          { id: "small", title: "Small", should: "s", severity: "low", notes: ["n0"] },
          { id: "big", title: "Big", should: "b", severity: "high", notes: ["n1", "n2"] },
        ],
      },
    ]);
    restore = m.restore;
    const modes = await group(traces, "agent", "claude-test");
    expect(modes.map((x) => [x.id, x.traces])).toEqual([["big", ["b", "c"]], ["small", ["a"]]]);
  });
});

describe("evidence grounding", () => {
  const transcript = `USER: book Tuesday
    [tool] book_meeting result → {"ok":false,"reason":"Slot \\"Tue 15:00\\" is full.\\nTry another."}
AGENT (turn 0): You're all set – it's booked for Tuesday at 3 PM.`;
  it("finds quotes from escaped JSON tool output and across punctuation styles", () => {
    expect(grounded('Slot "Tue 15:00" is full. Try another.', transcript)).toBe(true);
    expect(grounded('"ok": false', transcript)).toBe(true);
    expect(grounded("You're all set - it's booked", transcript)).toBe(true);
    expect(grounded("all set … booked for Tuesday", transcript)).toBe(true);
  });
  it("rejects quotes that aren't there, out of order, or too short to mean anything", () => {
    expect(grounded("booked for Wednesday", transcript)).toBe(false);
    expect(grounded("booked for Tuesday … You're all set", transcript)).toBe(false);
    expect(grounded(" ", transcript)).toBe(false);
    expect(grounded("booked", transcript)).toBe(false);
  });
});

describe("group note ids", () => {
  it("parses ids the model decorates, and keeps notes it left out", async () => {
    const traces: any[] = ["a", "b", "c"].map((id) => ({ id, review: { problems: [{ turn: 0, what: `w-${id}`, evidence: "e", severity: "high" }] } }));
    const m = fakeModel([{ modes: [{ id: "x", title: "X", should: "s", severity: "high", notes: ["n0 (a, turn 0)", "n1"] }] }]);
    restore = m.restore;
    const modes = await group(traces, "agent", "claude-test");
    expect(modes.map((x) => [x.id, x.traces])).toEqual([["x", ["a", "b"]], ["ungrouped", ["c"]]]);
  });
});
