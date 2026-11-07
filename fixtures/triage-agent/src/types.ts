export interface Ticket {
  id: string;
  subject: string;
  /** Written by the customer. */
  body: string;
  channel: "email" | "chat" | "web";
  attachments: string[];
}

export interface Customer {
  id: string;
  plan: "free" | "pro" | "enterprise";
  lifetimeValueUsd: number;
  openTickets: number;
}

export interface Triage {
  category: string;
  priority: "p1" | "p2" | "p3";
  auto_close: boolean;
  tags: string[];
  reply: string;
}
