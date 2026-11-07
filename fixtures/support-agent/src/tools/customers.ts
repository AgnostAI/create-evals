import { tool } from "ai";
import { z } from "zod";
import { customers } from "../lib/db.js";

export const lookupCustomer = tool({
  description: "Look up a customer's account by customer ID or email.",
  inputSchema: z.object({
    customerId: z.string().optional(),
    email: z.string().optional(),
  }),
  execute: async ({ customerId, email }) => {
    const customer = [...customers.values()].find((c) => c.id === customerId || c.email === email);
    if (!customer) return { found: false };
    return { found: true, ...customer };
  },
});
