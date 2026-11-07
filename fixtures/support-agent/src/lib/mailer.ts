export async function sendMail(to: string, subject: string, body: string) {
  return { messageId: `msg_${Date.now()}`, to, subject, bytes: body.length };
}
