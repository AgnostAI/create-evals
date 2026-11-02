// The safety net for running a real agent: only allowed hosts are reachable, and "now" can be pinned.
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { maybeCurrent } from "./context.js";
import { MODEL_HOSTS } from "./llm.js";

export const blocked: string[] = [];

function hostOf(target: unknown): string | undefined {
  try {
    if (typeof target === "string") return new URL(target).hostname;
    if (target instanceof URL) return target.hostname;
    if (target && typeof target === "object") {
      if ("url" in target && typeof (target as Request).url === "string") return new URL((target as Request).url).hostname;
      const o = target as { hostname?: string; host?: string };
      return o.hostname ?? o.host?.split(":")[0];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Block every outgoing request except model APIs and `allow`. A blocked request throws
 * and is recorded on the conversation, so a missed integration fails loudly instead of acting for real.
 */
export function guardNetwork(allow: string[] = []) {
  // Localhost isn't allowed by default: analytics and local backends often live there. Add it if a sandbox needs it.
  const allowed = new Set([...MODEL_HOSTS, ...allow]);
  const permitted = (host: string | undefined) => !host || allowed.has(host) || [...allowed].some((a) => a.startsWith("*.") && host.endsWith(a.slice(1)));
  const deny = (host: string) => {
    blocked.push(host);
    maybeCurrent()?.record({ kind: "error", name: "network-blocked", input: host });
    return new Error(`create-evals blocked a request to ${host}. Fake it in evals/ or add it to "allowHosts" in evals/create-evals.json.`);
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const host = hostOf(input);
    if (!permitted(host)) throw deny(host!);
    return realFetch(input, init);
  }) as typeof fetch;

  for (const mod of [http, https] as const) {
    for (const fn of ["request", "get"] as const) {
      const real = mod[fn] as (...a: any[]) => any;
      (mod as any)[fn] = (...args: any[]) => {
        const host = hostOf(args[0]) ?? hostOf(args[1]);
        if (!permitted(host)) throw deny(host!);
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
  class ShiftedDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) super(now());
      else super(...(args as [any]));
    }
    static now() {
      return now();
    }
  }
  globalThis.Date = ShiftedDate as DateConstructor;
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
