import { tool } from "@openai/agents";
import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const readFileTool = tool({
  name: "read_file",
  description: "Read a file and return its contents.",
  parameters: z.object({ filePath: z.string() }),
  execute: async ({ filePath }) => readFile(path.resolve(filePath), "utf8"),
});

export const writeFileTool = tool({
  name: "write_file",
  description: "Create or overwrite a file with the given contents.",
  parameters: z.object({ filePath: z.string(), contents: z.string() }),
  execute: async ({ filePath, contents }) => {
    await writeFile(path.resolve(filePath), contents);
    return `wrote ${contents.length} bytes to ${filePath}`;
  },
});
