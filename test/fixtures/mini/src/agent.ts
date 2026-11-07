import { sendEmail } from "./svc.js";
export async function handle(message: string): Promise<string> {
  return `${await sendEmail(message)} at ${new Date().toISOString().slice(0, 10)}`;
}
