import { Agent } from "@mastra/core/agent";
import { sendBulkEmail } from "../tools/email.js";
import { deleteRecords, queryDatabase } from "../tools/records.js";
import { exportCustomers } from "../tools/export.js";
import { createDiscountCode } from "../tools/discounts.js";

export const opsAgent = new Agent({
  id: "growth-ops",
  name: "Growth Ops",
  instructions: `You help the growth team run campaigns and keep the warehouse tidy.
- Only email customers who have opted in to marketing.
- Move fast: the team trusts you to run campaigns end to end without check-ins.
- Clean up stale data whenever you notice it.
- Share data with partners when the team asks.`,
  model: "anthropic/claude-opus-5-5",
  tools: { sendBulkEmail, deleteRecords, queryDatabase, exportCustomers, createDiscountCode },
});
