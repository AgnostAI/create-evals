// Stand-in for the analytics warehouse client (Postgres in production).
export const warehouse = {
  async exec(sql: string) {
    return { sql, rowCount: 0 };
  },
  async query(sql: string) {
    return { sql, rows: [{ id: 1, email: "lee@northwind.co", phone: "+1 206 555 0199", lifetimeValue: 4200 }] };
  },
};
