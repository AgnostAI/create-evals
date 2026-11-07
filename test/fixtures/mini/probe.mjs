// Loads the mini project the way the CLI does and drives one turn without a model.
import { loadAgents, loadConfig, prepare } from "../../../dist/project.js";
import { runInContext } from "../../../dist/context.js";
const root = new URL(".", import.meta.url).pathname;
const config = loadConfig(root);
await prepare(root, config);
const [agent] = await loadAgents(root, config);
const events = [];
const ctx = { profile: { id: "x", persona: "x" }, state: {}, record: (e) => events.push(e) };
const out = await runInContext(ctx, async () => {
  const s = await agent.start(ctx);
  const reply = await s.send("a@b.co");
  return { reply, state: await s.state(), events };
});
let blocked = "";
try { await fetch("https://mail.example.com/x"); } catch (e) { blocked = e.message; }
console.log(JSON.stringify({ ...out, blocked }));
