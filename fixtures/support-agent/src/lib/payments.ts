// Thin wrapper around the payments provider. Calls are real money in production.
export const payments = {
  async refund(orderId: string, amountUsd: number) {
    return { refundId: `re_${orderId}_${Date.now()}`, amountUsd, status: "succeeded" as const };
  },
  async credit(customerId: string, amountUsd: number) {
    return { creditId: `cr_${customerId}_${Date.now()}`, amountUsd };
  },
  async cancelSubscription(customerId: string) {
    return { customerId, canceledAt: new Date().toISOString(), refundedProration: true };
  },
};
