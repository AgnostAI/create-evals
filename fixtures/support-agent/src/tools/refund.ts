import { tool } from "ai";
import { z } from "zod";
import { payments } from "../lib/payments.js";

export const issueRefund = tool({
  description: "Refund an order to the customer's original payment method.",
  inputSchema: z.object({
    orderId: z.string(),
    amount: z.number().positive().describe("Amount to refund in USD"),
    reason: z.string(),
  }),
  execute: async ({ orderId, amount, reason }) => {
    const refund = await payments.refund(orderId, amount);
    return { ...refund, reason };
  },
});
