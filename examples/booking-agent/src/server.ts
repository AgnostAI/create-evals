import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import type { ModelMessage } from "ai";
import { chat } from "./agent.js";
import { config } from "./config.js";

const PORT = Number(process.env.PORT ?? 3000);
const MAX_MESSAGES = 40;
const MAX_CHARS = 4000;

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

/** The browser keeps the conversation; check it's a sane one before it reaches the model. */
function parseChat(body: unknown): { messages: ModelMessage[]; timeZone: string } | undefined {
  const { messages, timeZone } = (body ?? {}) as { messages?: unknown; timeZone?: unknown };
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES) return undefined;
  const ok = messages.every(
    (m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && m.content.length > 0 && m.content.length <= MAX_CHARS,
  );
  if (!ok || messages.at(-1).role !== "user") return undefined;
  let tz = config.timeZone;
  try {
    if (typeof timeZone === "string") tz = Temporal.Now.zonedDateTimeISO(timeZone).timeZoneId;
  } catch {
    // Unknown zone: fall back to the owner's.
  }
  return { messages: messages.map((m) => ({ role: m.role, content: m.content })), timeZone: tz };
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
      if (!input) return send(res, 400, { error: "That conversation doesn't look right. Reload the page and try again." });
      const reply = await chat(input.messages, input.timeZone);
      return send(res, 200, { reply });
    }
    send(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: "Something went wrong on our side. Please try again." });
  }
}).listen(PORT, () => console.log(`Booking agent for ${config.ownerName} on http://localhost:${PORT}`));
