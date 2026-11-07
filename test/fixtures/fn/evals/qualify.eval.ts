import assert from "node:assert/strict";
import { scenario } from "create-evals";
import { qualify } from "./agent.js";

scenario(qualify, "agent seller qualifies", {
  input: { domain: "acme.com", sellsAgents: true },
  check: ({ state }) => assert.equal(state.qualified, true),
});

scenario(qualify, "roundup field exists", {
  input: { domain: "acme.com", sellsAgents: true },
  pending: "triage doesn't output a roundup yet",
  check: ({ state }) => assert.ok("roundup" in state),
});
