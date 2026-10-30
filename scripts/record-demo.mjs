// Records a real `create-evals` run on a copy of fixtures/support-agent into an asciinema cast,
// then renders docs/demo.svg with svg-term. Needs ANTHROPIC_API_KEY and a built dist/.
//
//   npm run build && node scripts/record-demo.mjs
import { spawn, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "fixtures", "support-agent");
const dir = mkdtempSync(path.join(tmpdir(), "create-evals-demo-"));
cpSync(fixture, dir, { recursive: true, filter: (s) => !s.includes("node_modules") && !s.includes("/evals") });
symlinkSync(path.join(fixture, "node_modules"), path.join(dir, "node_modules"));

// Mostly "no", like a real first run.
const answers = { q01: "no", q02: "no", q03: "no", q04: "no", q05: "yes", q06: "no", q07: "no", q08: "no", q09: "no", q10: "no" };
writeFileSync(path.join(dir, "answers.json"), JSON.stringify(answers));

const WIDTH = 104;
const HEIGHT = 46;
const events = [];
let t = 0.4;
const emit = (text, dt = 0) => {
  t += dt;
  events.push([Number(t.toFixed(3)), "o", text]);
};

// Type the command.
emit("\x1b[32m$\x1b[0m ");
for (const ch of "npx create-evals") emit(ch, 0.06);
emit("\r\n", 0.5);

const child = spawn("node", [path.join(root, "dist", "cli.js"), ".", "--answers", "answers.json", "--no-install"], {
  cwd: dir,
  env: { ...process.env, FORCE_COLOR: "1", COLUMNS: String(WIDTH - 4) },
});

let last = Date.now();
let buffer = "";
const flushLines = (final = false) => {
  const parts = buffer.split("\n");
  buffer = final ? "" : parts.pop();
  for (const line of parts) {
    // Pause on each answer as if someone were reading the question and typing y/n.
    const isAnswer = /→/.test(line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""));
    emit(line.replace(/\r?$/, "") + "\r\n", isAnswer ? 1.4 : 0.03);
  }
  if (final && buffer) emit(buffer);
};

child.stdout.on("data", (chunk) => {
  const now = Date.now();
  // Compress model latency: real gaps capped at 1.2s.
  t += Math.min((now - last) / 1000, 1.2);
  last = now;
  const text = chunk.toString();
  if (/[◒◐◓◑]/.test(text) && !text.includes("\n")) emit("\r\x1b[2K" + text.replace(/\x1b\[[0-9;]*[GJK]/g, ""));
  else {
    buffer += text;
    flushLines();
  }
});
child.stderr.on("data", (c) => process.stderr.write(c));
child.on("close", (code) => {
  flushLines(true);
  emit("", 4);
  if (code !== 0) {
    console.error(`create-evals exited ${code}`);
    process.exit(1);
  }
  const cast = [JSON.stringify({ version: 2, width: WIDTH, height: HEIGHT, env: { TERM: "xterm-256color" } }), ...compressSpinners(events).map((e) => JSON.stringify(e))].join("\n");
  mkdirSync(path.join(root, "docs"), { recursive: true });
  const castFile = path.join(root, "docs", "demo.cast");
  writeFileSync(castFile, cast + "\n");
  execFileSync("npx", ["--yes", "svg-term-cli@2.1.1", "--in", castFile, "--out", path.join(root, "docs", "demo.svg"), "--window", "--width", String(WIDTH), "--height", String(HEIGHT), "--padding", "18"], { stdio: "inherit" });
  console.log(`wrote docs/demo.cast and docs/demo.svg (${events.length} frames, ${t.toFixed(1)}s)`);
});

/** Keep at most ~1.5s of each spinner run; the model's thinking time isn't interesting to watch. */
function compressSpinners(evts, maxFrames = 18) {
  const out = [];
  let shift = 0;
  let run = 0;
  let prev = 0;
  for (const [time, kind, text] of evts) {
    const spinner = /[◒◐◓◑]/.test(text) && !text.includes("\n");
    if (spinner) run++;
    else run = 0;
    if (spinner && run > maxFrames) {
      shift += time - prev;
      prev = time;
      continue;
    }
    prev = time;
    out.push([Number((time - shift).toFixed(3)), kind, text]);
  }
  return out;
}
