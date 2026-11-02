export async function sendEmail(to: string): Promise<string> {
  const res = await fetch(`https://mail.example.com/send?to=${to}`);
  return res.ok ? "sent" : "failed";
}
