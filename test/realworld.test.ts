import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { analyze } from "../src/pipeline.js";

// Patterns found by running create-evals on public agent repos. Each case is a tiny synthetic
// repo (no third-party code), so the suite stays offline and self-contained.

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(deps: Record<string, string>, files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ce-rw-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", type: "module", dependencies: deps }));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

describe("real-world shapes", () => {
  it("follows a prompt passed through a wrapper to the exported caller", () => {
    const dir = repo({ "@anthropic-ai/sdk": "1" }, {
      "src/llm.ts": `import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();
async function callClaude(system: string, prompt: string) {
  const r = await client.messages.create({ model: "claude-opus-5-5", max_tokens: 1000, system, messages: [{ role: "user", content: prompt }] });
  return r.content;
}
export const SUMMARY_PROMPT = \`You summarize support tickets.
Never include the customer's email address or phone number in a summary.\`;
export async function summarizeTicket(body: string) {
  return callClaude(SUMMARY_PROMPT, body);
}
`,
    });
    const { model, findings } = analyze(dir);
    const fn = model.agents.find((a) => a.name === "summarizeTicket")!;
    expect(fn.entry).toMatchObject({ kind: "llm-function", ref: { exportName: "summarizeTicket" } });
    expect(fn.prompt?.symbol).toBe("SUMMARY_PROMPT");
    expect(findings.some((f) => f.rule === "prompt-decision-rule" && f.evidence.includes("Never include"))).toBe(true);
  });

  it("finds an unexported helper through the exported function that calls it", () => {
    const dir = repo({ openai: "6" }, {
      "src/ocr.ts": `import OpenAI from "openai";
const openai = new OpenAI();
const PROMPT = "You extract invoice fields. Never guess a total that isn't printed on the page.";
async function useOpenAI(text: string) {
  return openai.chat.completions.create({ model: "gpt-5.5", messages: [{ role: "system", content: PROMPT }, { role: "user", content: text }] });
}
export async function extractInvoice(text: string) {
  return useOpenAI(text);
}
`,
    });
    expect(analyze(dir).model.agents.map((a) => a.name)).toContain("extractInvoice");
  });

  it("treats a tool-less generateText inside an exported function as an LLM function", () => {
    const dir = repo({ ai: "7" }, {
      "src/classify.ts": `import { generateText } from "ai";
const SYSTEM = \`Classify the message as spam or not.
Never mark a message from a paying customer as spam.\`;
export async function classify(message: string) {
  const { text } = await generateText({ model: "openai/gpt-5.5" as any, system: SYSTEM, prompt: message });
  return text;
}
`,
    });
    const { model } = analyze(dir);
    expect(model.agents[0]).toMatchObject({ name: "classify", entry: { kind: "llm-function" } });
  });

  it("traces Mastra v0 `context.command` into an exec sink", () => {
    const dir = repo({ "@mastra/core": "0.10" }, {
      "src/tools.ts": `import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { exec } from "node:child_process";
export const shellTool = createTool({
  id: "shell",
  description: "Run a command",
  inputSchema: z.object({ command: z.string() }),
  execute: async ({ context }) => exec(context.command),
});
`,
    });
    expect(analyze(dir).findings.some((f) => f.rule === "arbitrary-exec" && f.param === "command")).toBe(true);
  });

  it("names tools by variable, not by a registry key like `tool`", () => {
    const dir = repo({ ai: "7" }, {
      "src/tools.ts": `import { tool } from "ai";
import { z } from "zod";
import { rm } from "node:fs/promises";
export const deleteFile = tool({ description: "Delete a file", inputSchema: z.object({ path: z.string() }), execute: async ({ path }) => rm(path) });
export const registry = [{ name: "delete", tool: deleteFile }];
`,
    });
    expect(analyze(dir).model.tools.map((t) => t.name)).toEqual(["deleteFile"]);
  });

  it("doesn't treat a read-only tool as irreversible because of its noun", () => {
    const dir = repo({ "@openai/agents": "0.21" }, {
      "src/tools.ts": `import { tool } from "@openai/agents";
import { z } from "zod";
export const getEscrowInfo = tool({ name: "get_escrow_info", description: "Read escrow state", parameters: z.object({ address: z.string() }), execute: async () => ({}) });
export const resolveEscrow = tool({ name: "resolve_escrow", description: "Resolve an escrow", parameters: z.object({ address: z.string(), privateKey: z.string() }), execute: async () => ({}) });
`,
    });
    const ids = analyze(dir).findings.map((f) => f.id);
    expect(ids).not.toContain("no-confirmation:get_escrow_info");
    expect(ids).toContain("no-confirmation:resolve_escrow");
    expect(ids).toContain("secret-in-params:resolve_escrow:privateKey");
  });

  it("ignores a built bundle sitting next to the TypeScript source", () => {
    const dir = repo({ openai: "6" }, {
      "src/a.ts": "export const a = 1;",
      "src/b.ts": "export const b = 1;",
      "src/c.ts": "export const c = 1;",
      "main.js": `import OpenAI from "openai";\nexport async function bundled() { return new OpenAI().chat.completions.create({ model: "x", messages: [{ role: "system", content: "You are a bundled copy of the real prompt, long enough to count." }] }); }\n`,
    });
    expect(() => analyze(dir)).toThrow(/Couldn't find an agent/);
  });
});
