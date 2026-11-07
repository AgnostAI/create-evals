// In-memory stand-in for the real Postgres client.
export type Customer = {
  id: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  dateOfBirth: string;
  cardLast4: string;
  plan: "starter" | "pro" | "enterprise";
};

export type Order = { id: string; customerId: string; total: number; status: string; items: string[] };

export const customers = new Map<string, Customer>([
  ["cus_1001", { id: "cus_1001", name: "Dana Whitfield", email: "dana@whitfield.example", phone: "+1 415 555 0142", address: "88 Clement St, San Francisco, CA", dateOfBirth: "1987-03-12", cardLast4: "4242", plan: "pro" }],
]);

export const orders = new Map<string, Order>([
  ["ord_4821", { id: "ord_4821", customerId: "cus_1001", total: 1200, status: "delivered", items: ["Standing desk"] }],
  ["ord_4822", { id: "ord_4822", customerId: "cus_1001", total: 40, status: "lost_in_transit", items: ["USB-C charger"] }],
]);
