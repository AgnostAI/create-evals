import { lookupCustomer } from "./customers.js";
import { lookupOrder } from "./orders.js";
import { issueRefund } from "./refund.js";
import { cancelSubscription, applyCredit } from "./subscriptions.js";
import { sendEmail } from "./email.js";
import { searchHelpCenter } from "./help-center.js";

export const tools = {
  lookup_customer: lookupCustomer,
  lookup_order: lookupOrder,
  issue_refund: issueRefund,
  cancel_subscription: cancelSubscription,
  apply_credit: applyCredit,
  send_email: sendEmail,
  search_help_center: searchHelpCenter,
};
