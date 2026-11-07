// Drives the real network guard and fetch wrapper against a local fake model server, inside a conversation.
import http from "node:http";
import { prepare } from "../../../dist/project.js";
import { runInContext, outsideContext } from "../../../dist/context.js";

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    if (req.url === "/v1/messages") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ model: "claude-x", stop_reason: "tool_use", content: [{ type: "text", text: "Turn the power off first." }, { type: "tool_use", name: "create_ticket", input: { subject: "hot unit" } }] }));
    } else if (req.url === "/v1/chat/completions") {
      res.setHeader("content-type", "text/event-stream");
      const chunks = [
        { choices: [{ delta: { content: "Hel" } }] },
        { choices: [{ delta: { content: "lo" } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "lookup", arguments: '{"id":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"7"}' } }] }, finish_reason: "tool_calls" }] },
      ];
      res.end(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n");
    } else res.end("{}");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
await prepare(new URL(".", import.meta.url).pathname, { allowHosts: ["127.0.0.1"] });

const events = [];
const ctx = { profile: { id: "p" }, state: {}, record: (e) => events.push({ ...e }) };
await runInContext(ctx, async () => {
  const a = await fetch(`${base}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "claude-x", system: "You are Owly. Contact: a@b.example", messages: [{ role: "user", content: "my unit smells" }], tools: [{ name: "create_ticket" }] }) });
  await a.json();
  const b = await fetch(`${base}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-x", stream: true, messages: [{ role: "system", content: "You are Owly. Contact: a@b.example" }, { role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "order 7?" }] }) });
  await b.text();
  // create-evals' own calls run outside the conversation and aren't recorded.
  await outsideContext(() => fetch(`${base}/v1/messages`, { method: "POST", body: "{}" }).then((r) => r.text()));
  // Not a model API: not recorded.
  await fetch(`${base}/health`, { method: "POST", body: "{}" }).then((r) => r.text());
});
await new Promise((r) => setTimeout(r, 50));
server.close();
console.log(JSON.stringify(events));
