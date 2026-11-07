// The safety net for running a real agent: only allowed hosts are reachable, and "now" can be pinned.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { maybeCurrent } from "./context.js";
import { observe } from "./observe.js";
import { MODEL_HOSTS } from "./llm.js";

export const blocked: string[] = [];

/** The host a request will actually go to. For node:http, options win over the URL (as Node does). */
function hostOf(...args: unknown[]): string | undefined {
  let host: string | undefined;
  for (const a of args) {
    try {
      if (typeof a === "string" && /^[a-z]+:\/\//i.test(a)) host = new URL(a).hostname;
      else if (a instanceof URL) host = a.hostname;
      else if (a && typeof a === "object") {
        if ("url" in a && typeof (a as Request).url === "string") host = new URL((a as Request).url).hostname;
        const o = a as { hostname?: string; host?: string };
        if (o.hostname || o.host) host = o.hostname ?? o.host!.replace(/:\d+$/, "");
      }
    } catch {
      // unparseable: leave as is
    }
  }
  return host?.toLowerCase().replace(/^\[|\]$/g, "");
}

let guarded = false;

/**
 * Block every outgoing connection except model APIs and `allow`. Enforced at the socket layer
 * (net.Socket#connect), so fetch, node:http(s), undici, WebSocket, tls and net are all covered;
 * fetch and http also get a clear error up front. A blocked attempt throws and is recorded on the
 * conversation, so a missed integration fails loudly instead of acting for real. Child processes
 * are not covered: use spawnSession() and the language helper's guard().
 */
export function guardNetwork(allow: string[] = []) {
  if (guarded) return;
  guarded = true;
  const allowed = new Set([...MODEL_HOSTS, ...allow].map((h) => h.toLowerCase()));
  const permitted = (host: string) => allowed.has(host) || [...allowed].some((a) => a.startsWith("*.") && host.endsWith(a.slice(1)));
  const deny = (host: string) => {
    blocked.push(host);
    maybeCurrent()?.record({ kind: "error", name: "network-blocked", input: host });
    return new Error(`create-evals blocked a request to ${host}. Fake it in evals/ or add it to "allowHosts" in evals/create-evals.json.`);
  };

  // Socket layer: every TCP/TLS connection, whoever opens it. IPC sockets (a path, no host) are local plumbing.
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const isIpc = (first && typeof first === "object" && "path" in first && first.path) || (typeof first === "string" && Number.isNaN(Number(first)));
    if (!isIpc) {
      const host = (typeof first === "object" ? (first.host ?? first.hostname) : typeof args[1] === "string" ? args[1] : undefined) ?? "localhost";
      const name = String(host).toLowerCase();
      if (!permitted(name)) {
        const err = deny(name);
        process.nextTick(() => this.destroy(err));
        return this;
      }
    }
    return (realConnect as any).apply(this, args);
  } as typeof net.Socket.prototype.connect;

  // fetch and node:http(s): same rule, with the error thrown where the agent made the call.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const host = hostOf(input) ?? "localhost";
    if (!permitted(host)) throw deny(host);
    // The agent's own model calls go on the trace (create-evals' own run outside the conversation).
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
    const seen = url ? observe(url, init?.method ?? (input as Request)?.method, init?.body) : undefined;
    try {
      const res = await realFetch(input, init);
      seen?.(res);
      return res;
    } catch (e) {
      seen?.(e as Error);
      throw e;
    }
  }) as typeof fetch;
  for (const mod of [http, https] as const) {
    for (const fn of ["request", "get"] as const) {
      const real = mod[fn] as (...a: any[]) => any;
      (mod as any)[fn] = (...args: any[]) => {
        const host = hostOf(args[0], typeof args[1] === "object" ? args[1] : undefined) ?? "localhost";
        if (!permitted(host)) throw deny(host);
        return real.apply(mod, args);
      };
    }
  }
  syncBuiltinESMExports();
}

/** Make the clock start at `iso` and keep ticking from there (timers still work). Covers Date and Temporal. */
export function shiftClock(iso: string) {
  const RealDate = Date;
  const offset = RealDate.parse(iso) - RealDate.now();
  if (Number.isNaN(offset)) throw new Error(`create-evals: "now" isn't a valid date: ${iso}`);
  const now = () => RealDate.now() + offset;
  // A Proxy keeps `instanceof Date`, Date.UTC/parse and `Date()` (a string) working.
  globalThis.Date = new Proxy(RealDate, {
    construct: (target, args) => (args.length ? new target(...(args as [any])) : new target(now())),
    apply: () => new RealDate(now()).toString(),
    get: (target, prop, receiver) => (prop === "now" ? now : Reflect.get(target, prop, receiver)),
  });
  const T = (globalThis as any).Temporal;
  if (T?.Now) {
    const instant = () => T.Instant.fromEpochMilliseconds(now());
    const zone = (tz?: string) => tz ?? T.Now.timeZoneId();
    T.Now.instant = instant;
    T.Now.zonedDateTimeISO = (tz?: string) => instant().toZonedDateTimeISO(zone(tz));
    T.Now.plainDateTimeISO = (tz?: string) => instant().toZonedDateTimeISO(zone(tz)).toPlainDateTime();
    T.Now.plainDateISO = (tz?: string) => instant().toZonedDateTimeISO(zone(tz)).toPlainDate();
    T.Now.plainTimeISO = (tz?: string) => instant().toZonedDateTimeISO(zone(tz)).toPlainTime();
  }
}
