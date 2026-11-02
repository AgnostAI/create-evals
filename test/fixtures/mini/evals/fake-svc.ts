import { current } from "create-evals";
export async function sendEmail(to: string): Promise<string> {
  current().state.sent.push(to);
  current().record({ kind: "state", name: "email.sent", input: to });
  return "fake-sent";
}
