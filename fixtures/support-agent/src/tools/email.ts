import { tool } from "ai";
import { z } from "zod";
import { sendMail } from "../lib/mailer.js";

export const sendEmail = tool({
  description: "Send an email to a customer.",
  inputSchema: z.object({
    to: z.string(),
    subject: z.string(),
    body: z.string(),
  }),
  execute: async ({ to, subject, body }) => sendMail(to, subject, body),
});
