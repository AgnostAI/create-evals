import { describe, expect, it } from "vitest";
import http from "node:http";
import { blocked, guardNetwork, shiftClock } from "../src/sandbox.js";

describe("sandbox", () => {
  it("blocks hosts that aren't allowed, for fetch and node:http", async () => {
    guardNetwork(["allowed.example"]);
    await expect(fetch("http://localhost:9/x")).rejects.toThrow(/blocked a request to localhost/);
    await expect(fetch("https://evil.example/x")).rejects.toThrow(/blocked a request to evil.example/);
    expect(() => http.request("http://evil.example/")).toThrow(/blocked/);
    expect(blocked).toContain("evil.example");
  });

  it("shifts Date and Temporal.Now to the pinned time, and keeps ticking", async () => {
    shiftClock("2026-11-02T09:00:00+05:30");
    const pinned = Date.parse("2026-11-02T09:00:00+05:30");
    expect(Math.abs(Date.now() - pinned)).toBeLessThan(1000);
    expect(Math.abs(new Date().getTime() - pinned)).toBeLessThan(1000);
    expect(new Date(0).getTime()).toBe(0);
    expect(Math.abs(Temporal.Now.instant().epochMilliseconds - pinned)).toBeLessThan(1000);
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 20));
    expect(Date.now()).toBeGreaterThan(t0);
  });
});
