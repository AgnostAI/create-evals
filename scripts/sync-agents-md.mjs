// AGENTS.md is SKILL.md minus frontmatter, nested one heading level down. Run after editing SKILL.md.
import { readFileSync, writeFileSync } from "node:fs";

const skill = readFileSync(new URL("../skill/create-evals/SKILL.md", import.meta.url), "utf8");
const body = skill.split("---").slice(2).join("---").trimStart().replace("# create-evals\n\n", "").replace(/^## /gm, "### ");
const out = `## create-evals\n\nWhen the developer asks for evals, agent tests, or guardrail tests for the AI agent in this repo, follow these steps.\n\n${body}`;
writeFileSync(new URL("../skill/AGENTS.md", import.meta.url), out);
