import { describe, it, expect } from "vitest";
import { orders } from "../src/lib/db.js";

describe("orders fixture data", () => {
  it("has the demo orders", () => {
    expect(orders.get("ord_4821")?.total).toBe(1200);
  });
});
