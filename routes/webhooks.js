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
  // Get the product name so we know which plan this is
  const priceId = subscription.items.data[0]?.price?.id;
  let planName = null;

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
      subscription_status: subscription.status,
      subscription_plan: planName,
      current_period_end: new Date(subscription.current_period_end * 1000),
    },
    { where: { stripe_customer_id: subscription.customer } },
  );
}

async function handleCanceled(subscription) {
  await User.update(
    {
      subscription_status: "canceled",
      subscription_plan: null,
      current_period_end: null,
    },
    { where: { stripe_customer_id: subscription.customer } },
  );
}

async function handlePaymentSucceeded(invoice) {
  if (!invoice.subscription) return; // skip one-off invoices

  // It's technically active once it succeeds, though standard handling relies more on `customer.subscription.updated`.
  // This acts as a fallback or explicit state flip.
  await User.update(
    { subscription_status: "active" },
    { where: { stripe_customer_id: invoice.customer } },
  );
}

async function handlePaymentFailed(invoice) {
  if (!invoice.subscription) return;

  await User.update(
    { subscription_status: "past_due" },
    { where: { stripe_customer_id: invoice.customer } },
  );
}

module.exports = router;
