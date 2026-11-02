import { describe, expect, it } from "vitest";
import { spawnSession } from "../src/spawn.js";

describe("spawnSession (Python line protocol)", () => {
  it("keeps one process per conversation, records events and state, and guards the network", async () => {
    const events: any[] = [];
    const ctx: any = { profile: { id: "p1" }, state: {}, record: (e: any) => events.push(e) };
    const s = spawnSession(ctx, ["python3", "test/fixtures/py/agent.py"]);
    expect(await s.send("first")).toBe("saved 1 for p1");
    expect(await s.send("second")).toBe("saved 2 for p1");
    expect(await s.send("fetch")).toMatch(/^blocked: /);
    expect(events.map((e) => e.name)).toEqual(["note.saved", "note.saved", "network-blocked"]);
    expect(await s.state!()).toEqual({ notes: ["first", "second"] });
    await s.close!();
  });
});
