import { tool } from "ai";
import { z } from "zod";
import { orders } from "../lib/db.js";

export const lookupOrder = tool({
  description: "Fetch an order by ID, including total and delivery status.",
  inputSchema: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => orders.get(orderId) ?? { error: "order not found" },
});
