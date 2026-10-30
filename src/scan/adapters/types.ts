import type { AgentDef, Framework, ToolDef } from "../../core/types.js";
import type { ScanContext } from "../project.js";

export interface Adapter {
  framework: Framework;
  /** Packages whose presence suggests this framework. */
  packages: string[];
  scan(ctx: ScanContext): { tools: ToolDef[]; agents: AgentDef[]; skipped?: SkippedSite[] };
}

/** An LLM call the adapter saw but couldn't turn into an agent, and why. */
export interface SkippedSite {
  loc: import("../../core/types.js").SourceLoc;
  reason: string;
}
