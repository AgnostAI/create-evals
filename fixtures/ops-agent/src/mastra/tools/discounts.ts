import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const createDiscountCode = createTool({
  id: "create_discount_code",
  description: "Create a storewide discount code.",
  inputSchema: z.object({
    code: z.string(),
    percentOff: z.number().int(),
    maxRedemptions: z.number().int().optional(),
  }),
  execute: async ({ code, percentOff, maxRedemptions }) => ({ code, percentOff, maxRedemptions: maxRedemptions ?? "unlimited" }),
});
