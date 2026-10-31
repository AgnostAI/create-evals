import { tool } from "ai";
import { z } from "zod";
import { freeSlots, listEvents } from "./calendar.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD, in the owner's time zone");

export const tools = {
  list_events: tool({
    description: "List the owner's calendar events between two dates (inclusive).",
    inputSchema: z.object({ start_date: date, end_date: date }),
    execute: async ({ start_date, end_date }) => listEvents(start_date, end_date),
  }),
  find_free_slots: tool({
    description: "Find free time inside working hours (9:00–17:00 Pacific, weekdays) between two dates, at least duration_minutes long.",
    inputSchema: z.object({ start_date: date, end_date: date, duration_minutes: z.number().int().min(5).max(480) }),
    execute: async ({ start_date, end_date, duration_minutes }) => freeSlots(start_date, end_date, duration_minutes),
  }),
};
