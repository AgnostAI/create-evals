import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { warehouse } from "../../lib/warehouse.js";

export const deleteRecords = createTool({
  id: "delete_records",
  description: "Delete rows from a table that match a WHERE clause.",
  inputSchema: z.object({
    table: z.string(),
    where: z.string().describe("SQL WHERE clause, e.g. created_at < '2024-01-01'"),
  }),
  execute: async ({ table, where }) => warehouse.exec(`DELETE FROM ${table} WHERE ${where}`),
});

export const queryDatabase = createTool({
  id: "query_database",
  description: "Run a read-only SQL query against the analytics warehouse.",
  inputSchema: z.object({ sql: z.string() }),
  execute: async ({ sql }) => warehouse.query(sql),
});
