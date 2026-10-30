// Email service provider. Each send is billed and lands in real inboxes.
export async function sendCampaign(recipients: string[], subject: string, html: string) {
  return { campaignId: `cmp_${Date.now()}`, queued: recipients.length, subject, bytes: html.length };
}
