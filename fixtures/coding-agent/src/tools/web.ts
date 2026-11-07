import { tool } from "@openai/agents";
import { z } from "zod";

export const fetchUrl = tool({
  name: "fetch_url",
  description: "Fetch a web page and return its text content.",
  parameters: z.object({ url: z.string() }),
  execute: async ({ url }) => {
    const res = await fetch(url);
    return await res.text();
  },
});
