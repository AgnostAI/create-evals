import { Mastra } from "@mastra/core/mastra";
import { opsAgent } from "./agents/ops-agent.js";

export const mastra = new Mastra({ agents: { opsAgent } });
