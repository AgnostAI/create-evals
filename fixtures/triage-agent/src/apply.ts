import type { Ticket, Triage } from "./types.js";

// Stand-in for the helpdesk API.
export async function applyTriage(ticket: Ticket, triage: Triage) {
  const actions = [`tag ${triage.tags.join(",")}`, `priority ${triage.priority}`];
  if (triage.auto_close) actions.push(`reply+close: ${triage.reply}`);
  return { ticketId: ticket.id, actions };
}
