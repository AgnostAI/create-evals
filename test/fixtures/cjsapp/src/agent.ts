import { db } from "@/lib/db";
import { shout } from "./util";

export async function answer(id: string) {
  return shout(db.find(id));
}
