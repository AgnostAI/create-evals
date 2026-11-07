import { tool } from "ai";
import { z } from "zod";
import { payments } from "../lib/payments.js";

export const cancelSubscription = tool({
  description: "Cancel the customer's subscription immediately.",
  inputSchema: z.object({ customerId: z.string() }),
  execute: async ({ customerId }) => payments.cancelSubscription(customerId),
});

export const applyCredit = tool({
  description: "Add account credit as a goodwill gesture.",
  inputSchema: z.object({
    customerId: z.string(),
    amount: z.number().describe("Credit in USD"),
  }),
  execute: async ({ customerId, amount }) => payments.credit(customerId, amount),
});
