import { tool } from "ai";
import { z } from "zod";
import { searchArticles } from "../lib/cms.js";

export const searchHelpCenter = tool({
  description: "Search help-center articles and return their full text.",
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }) => searchArticles(query),
});
