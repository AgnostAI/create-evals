import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Needs `npm run build` first (it exercises the built loader hooks, like the CLI does).
describe("running an agent with a replaced module", () => {
  it("swaps the module for its fake, pins the clock, and blocks the real host", () => {
    const out = JSON.parse(execFileSync(process.execPath, ["test/fixtures/mini/probe.mjs"], { encoding: "utf8" }));
    expect(out.reply).toBe("fake-sent at 2030-01-15");
    expect(out.state).toEqual({ sent: ["a@example.com"] });
    expect(out.events).toEqual([{ kind: "state", name: "email.sent", input: "a@example.com" }]);
    expect(out.blocked).toMatch(/blocked a request to mail.example.com/);
  });
});
