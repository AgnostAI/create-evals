import { describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { blocked, guardNetwork, shiftClock } from "../src/sandbox.js";

describe("network guard", () => {
  guardNetwork(["Allowed.Example"]);

  it("blocks fetch and node:http to hosts that aren't allowed, localhost included", async () => {
    await expect(fetch("https://evil.example/x")).rejects.toThrow(/blocked a request to evil.example/);
    await expect(fetch("http://localhost:9/x")).rejects.toThrow(/blocked a request to localhost/);
    expect(() => http.request("http://evil.example/")).toThrow(/blocked/);
    expect(blocked).toContain("evil.example");
  });

  it("checks where http.request really goes: options win over the URL; no host means localhost", () => {
    expect(() => http.request("http://api.anthropic.com/", { hostname: "example.org" })).toThrow(/example.org/);
    expect(() => http.request({ port: 9 })).toThrow(/localhost/);
  });

  it("guards raw sockets, so undici, tls and WebSocket can't route around it", async () => {
    const viaNet = await new Promise<string>((resolve) => net.connect(443, "evil.example").on("error", (e) => resolve(e.message)));
    expect(viaNet).toMatch(/blocked a request to evil.example/);
    const viaTls = await new Promise<string>((resolve) => tls.connect({ host: "evil.example", port: 443 }).on("error", (e) => resolve(e.message)));
    expect(viaTls).toMatch(/blocked/);
  });

  it("matches allowed hosts case-insensitively", () => {
    const s = net.connect(443, "ALLOWED.example");
    s.on("error", () => {}); // DNS will fail; what matters is that the guard let it through
    expect(blocked).not.toContain("allowed.example");
    s.destroy();
  });
});

describe("clock", () => {
  it("shifts Date and Temporal.Now, keeps ticking, and keeps Date's other behavior", async () => {
    const before = new Date(); // made before the shift
    shiftClock("2026-11-02T09:00:00+05:30");
    const pinned = Date.parse("2026-11-02T09:00:00+05:30");
    expect(Math.abs(Date.now() - pinned)).toBeLessThan(1000);
    expect(Math.abs(new Date().getTime() - pinned)).toBeLessThan(1000);
    expect(new Date(0).getTime()).toBe(0);
    expect(Date.UTC(2020, 0, 1)).toBe(1577836800000);
    expect(typeof Date()).toBe("string");
    expect(Date()).toContain("2026");
    expect(before instanceof Date).toBe(true);
    expect(new Date() instanceof Date).toBe(true);
    // Temporal ships in Node 26+; on older Node only Date is shifted.
    if (typeof Temporal !== "undefined") expect(Math.abs(Temporal.Now.instant().epochMilliseconds - pinned)).toBeLessThan(1000);
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 20));
    expect(Date.now()).toBeGreaterThan(t0);
  });
});
