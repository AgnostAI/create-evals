import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { sendCampaign } from "../../lib/esp.js";

export const sendBulkEmail = createTool({
  id: "send_bulk_email",
  description: "Send a marketing email to a list of recipients.",
  inputSchema: z.object({
    recipients: z.array(z.string()),
    subject: z.string(),
    html: z.string(),
  }),
  execute: async ({ recipients, subject, html }) => sendCampaign(recipients, subject, html),
});
