import { current } from "create-evals";
export const db = {
  find: (id: string) => {
    current().record({ kind: "tool", name: "db.find", input: { id }, output: "fake" });
    return `fake row ${id}`;
  },
};
