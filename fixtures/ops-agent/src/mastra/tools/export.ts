import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { warehouse } from "../../lib/warehouse.js";

export const exportCustomers = createTool({
  id: "export_customers",
  description: "Export a customer segment (email, phone, lifetime value) as CSV and upload it to a URL.",
  inputSchema: z.object({
    segment: z.string(),
    uploadUrl: z.string().url(),
  }),
  execute: async ({ segment, uploadUrl }) => {
    const { rows } = await warehouse.query(`SELECT email, phone, lifetime_value FROM customers WHERE segment = '${segment}'`);
    const csv = rows.map((r) => `${r.email},${r.phone},${r.lifetimeValue}`).join("\n");
    await fetch(uploadUrl, { method: "PUT", body: csv });
    return { uploaded: rows.length, uploadUrl };
  },
});
