// One-time setup: sign in with Google and save a refresh token (plus the calendar's time zone) to .env.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { requireEnv } from "./env.js";
import { SCOPES, calendarInfo } from "./google.js";

const ENV = new URL("../.env", import.meta.url);
const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const clientId = requireEnv("GOOGLE_CLIENT_ID");
const clientSecret = requireEnv("GOOGLE_CLIENT_SECRET");
const state = crypto.randomUUID();

function saveEnv(values: Record<string, string>) {
  let text = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, "\n")}${line}\n`;
    process.env[key] = value;
  }
  writeFileSync(ENV, text);
}

const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
url.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT,
  response_type: "code",
  scope: SCOPES.join(" "),
  access_type: "offline",
  prompt: "consent",
  state,
}).toString();

const server = createServer(async (req, res) => {
  const params = new URL(req.url ?? "/", REDIRECT).searchParams;
  if (!req.url?.startsWith("/callback")) return res.writeHead(404).end();
  if (params.get("state") !== state || !params.get("code")) {
    res.writeHead(400).end(`Sign-in failed: ${params.get("error") ?? "bad state"}`);
    return;
  }
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ code: params.get("code")!, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT, grant_type: "authorization_code" }),
  });
  const tokens = (await tokenRes.json()) as { refresh_token?: string; scope?: string; error_description?: string };
  if (!tokens.refresh_token) {
    res.writeHead(500).end("No refresh token came back. Check the terminal.");
    console.error("Google didn't return a refresh token:", tokens.error_description ?? tokens);
    process.exit(1);
  }
  const missing = SCOPES.filter((s) => !tokens.scope?.split(" ").includes(s));
  if (missing.length) console.warn(`Warning: these permissions weren't granted: ${missing.join(", ")}. Tick every box on the consent screen.`);
  saveEnv({ GOOGLE_REFRESH_TOKEN: tokens.refresh_token });

  const info = await calendarInfo();
  if (!process.env.OWNER_TIMEZONE) saveEnv({ OWNER_TIMEZONE: info.timeZone });
  res.writeHead(200, { "content-type": "text/plain" }).end("Connected. You can close this tab.");
  console.log(`Connected to ${info.summary} (${info.timeZone}). Saved to .env.`);
  server.close();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Opening Google sign-in. If nothing opens, visit:\n${url}\n`);
  spawn(process.platform === "darwin" ? "open" : "xdg-open", [url.toString()], { stdio: "ignore", detached: true }).on("error", () => {});
});
