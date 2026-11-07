import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import type { ModelMessage } from "ai";
import { agent } from "./agent.js";
import { config } from "./config.js";

const PORT = Number(process.env.PORT ?? 3000);
const MAX_TURNS = 40;
const MAX_CHARS = 4000;
const SESSION_TTL_MS = 2 * 60 * 60_000;

// Conversations live on the server, tool calls and results included: the agent needs its own
// earlier actions to stay truthful, and a browser-supplied history could be forged.
interface Session {
  history: ModelMessage[];
  turns: number;
  timeZone: string;
  touched: number;
}
const sessions = new Map<string, Session>();
function session(id: unknown, timeZone: string): [string, Session] {
  const now = Date.now();
  for (const [key, s] of sessions) if (now - s.touched > SESSION_TTL_MS) sessions.delete(key);
  const existing = typeof id === "string" ? sessions.get(id) : undefined;
  if (existing) return [id as string, existing];
  const fresh: Session = { history: [], turns: 0, timeZone, touched: now };
  const key = crypto.randomUUID();
  sessions.set(key, fresh);
  return [key, fresh];
}

// A small per-IP limit so a public page can't run up the model bill.
const WINDOW_MS = 10 * 60_000;
const MAX_REQUESTS = 30;
const hits = new Map<string, number[]>();
function limited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > MAX_REQUESTS;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (await readFile(new URL("../public/index.html", import.meta.url), "utf8")).replaceAll("{{OWNER_NAME}}", escapeHtml(config.ownerName));

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200_000) throw new Error("body too large");
  }
  return JSON.parse(raw);
}

/** One new guest message, plus the session it belongs to (if any) and the browser's time zone. */
function parseChat(body: unknown): { sessionId?: unknown; message: string; timeZone: string } | undefined {
  const { sessionId, message, timeZone } = (body ?? {}) as { sessionId?: unknown; message?: unknown; timeZone?: unknown };
  if (typeof message !== "string" || !message.trim() || message.length > MAX_CHARS) return undefined;
  let tz = config.timeZone;
  try {
    if (typeof timeZone === "string") tz = Temporal.Now.zonedDateTimeISO(timeZone).timeZoneId;
  } catch {
    // Unknown zone: fall back to the owner's.
  }
  return { sessionId, message: message.trim(), timeZone: tz };
}

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?"))) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
      return;
    }
    if (req.method === "POST" && req.url === "/api/chat") {
      const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim() ?? req.socket.remoteAddress ?? "?";
      if (limited(ip)) return send(res, 429, { error: "Too many messages. Try again in a few minutes." });
      const input = parseChat(await readJson(req));
      if (!input) return send(res, 400, { error: "That message doesn't look right. Please try again." });
      const [sessionId, s] = session(input.sessionId, input.timeZone);
      if (s.turns >= MAX_TURNS) return send(res, 429, { error: "This conversation is too long. Reload the page to start a new one." });
      const history: ModelMessage[] = [...s.history, { role: "user", content: input.message }];
      const reply = await agent.respond(history, s.timeZone);
      s.history = [...history, ...reply.messages];
      s.turns++;
      s.touched = Date.now();
      return send(res, 200, { sessionId, reply: reply.text });
    }
    send(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: "Something went wrong on our side. Please try again." });
  }
}).listen(PORT, () => console.log(`Booking agent for ${config.ownerName} on http://localhost:${PORT}`));
