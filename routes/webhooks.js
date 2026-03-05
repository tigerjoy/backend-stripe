const express = require("express");
const stripe = require("../lib/stripe");
const { User } = require("../lib/db");
const router = express.Router();

// CRITICAL: raw body required for signature verification
router.post(
  "/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      console.error("Webhook signature failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.paused":
        case "customer.subscription.resumed":
          await syncSubscription(event.data.object);
          break;

        case "customer.subscription.deleted":
          await handleCanceled(event.data.object);
          break;

        case "invoice.payment_succeeded":
          await handlePaymentSucceeded(event.data.object);
          break;

        case "invoice.payment_failed":
          await handlePaymentFailed(event.data.object);
          break;

        default:
          console.log(`Unhandled event type ${event.type}`);
      }

      res.json({ received: true });
    } catch (err) {
      console.error("Webhook handler error:", err);
      res.status(500).json({ error: "Handler failed" });
    }
  },
);

// ─── Handlers ────────────────────────────────────────────────

async function syncSubscription(subscription) {
  // Get the product name and amount so we know which plan this is
  const item = subscription.items.data[0];
  const priceId = item?.price?.id;
  
  let planName = null;
  let amountCents = null;

  if (item) {
    amountCents = item.price.unit_amount;
  }

  if (priceId) {
    try {
      const price = await stripe.prices.retrieve(priceId, {
        expand: ["product"],
      });
      // Depending on product object expansion
      planName = price.product.name; // e.g. "Pro Plan"
    } catch (err) {
      console.error("Error fetching price for webhook sync", err);
    }
  }

  await User.update(
    {
      stripe_subscription_id: subscription.id,
      subscription_status: subscription.status,
      subscription_plan: planName,
      subscription_amount: amountCents,
      current_period_end: subscription.current_period_end ? new Date(subscription.current_period_end * 1000) : null,
      trial_end: subscription.trial_end
        ? new Date(subscription.trial_end * 1000)
        : null,
    },
    { where: { stripe_customer_id: subscription.customer } },
  );
}

async function handleCanceled(subscription) {
  await User.update(
    {
      stripe_subscription_id: null,
      subscription_status: "canceled",
      subscription_plan: null,
      subscription_amount: null,
      current_period_end: null,
      trial_end: null,
    },
    { where: { stripe_customer_id: subscription.customer } },
  );
}

async function handlePaymentSucceeded(invoice) {
  if (!invoice.subscription) return; // skip one-off invoices

  // Fetch the canonical subscription to get the absolutely correct status 
  // (could be active, trialing, incomplete to active, etc.)
  const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
  
  await User.update(
    { subscription_status: subscription.status },
    { where: { stripe_subscription_id: invoice.subscription } },
  );
}

async function handlePaymentFailed(invoice) {
  if (!invoice.subscription) return;

  // Retrieve the subscription to know if it became past_due, incomplete, unpaid, etc.
  const subscription = await stripe.subscriptions.retrieve(invoice.subscription);

  await User.update(
    { subscription_status: subscription.status },
    { where: { stripe_subscription_id: invoice.subscription } },
  );
}

module.exports = router;
