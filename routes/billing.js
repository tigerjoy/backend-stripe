const express = require("express");
const stripe = require("../lib/stripe");
const { requireAuth } = require("./users");

const router = express.Router();

// Create a Stripe Checkout session for the plan
router.post("/checkout", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const { priceId } = req.body; // Passed from frontend (e.g., from Starter, Pro, or Pro Plus)

    if (!priceId) {
      return res.status(400).json({ error: "priceId is required" });
    }

    const session = await stripe.checkout.sessions.create({
      customer: user.stripe_customer_id,
      mode: "subscription",
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${process.env.FRONTEND_URL}/dashboard?checkout=success`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing`,
      allow_promotion_codes: true, // lets admin create discount codes in Dashboard
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Checkout error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Customer Portal — user manages their own billing (cancel, update card, view invoices)
router.post("/portal", requireAuth, async (req, res) => {
  try {
    const user = req.user;

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/dashboard`, // We'll return them to the dashboard
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Portal error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Create a Stripe embedded subscription session for the plan
router.post("/subscribe-embedded", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const { priceId } = req.body;

    if (!priceId) {
      return res.status(400).json({ error: "priceId is required" });
    }

    const subscription = await stripe.subscriptions.create({
      customer: user.stripe_customer_id,
      items: [{ price: priceId }],
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      expand: ["latest_invoice.confirmation_secret"],
    });

    const invoice = subscription.latest_invoice;
    const confirmationSecret = invoice ? invoice.confirmation_secret : null;

    if (!confirmationSecret) {
      console.warn(
        "No confirmation secret found on the latest invoice.",
        subscription,
      );
    }

    res.json({
      subscriptionId: subscription.id,
      clientSecret: confirmationSecret
        ? confirmationSecret.client_secret
        : null,
      status: subscription.status,
    });
  } catch (err) {
    console.error("Subscription error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Create a Stripe subscription with a 30-day trial (App 4)
// Stripe collects card details upfront but does NOT charge until trial ends.
router.post("/subscribe-trial", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const { priceId } = req.body;

    if (!priceId) {
      return res.status(400).json({ error: "priceId is required" });
    }

    // With trial_period_days, Stripe creates an incomplete subscription with a
    // $0 invoice. We still need to collect a payment method so the card can
    // be charged once the trial ends. We use payment_behavior "default_incomplete"
    // which gives us a confirmation_secret (SetupIntent client_secret) to render
    // the Stripe Payment Element for card collection.
    const subscription = await stripe.subscriptions.create({
      customer: user.stripe_customer_id,
      items: [{ price: priceId }],
      trial_period_days: 30,
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      expand: ["latest_invoice.confirmation_secret", "pending_setup_intent"],
    });

    // For a trial sub the pending_setup_intent holds the client_secret
    // (not the invoice, which is $0 and has no payment needed).
    let clientSecret = null;
    if (subscription.pending_setup_intent) {
      clientSecret = subscription.pending_setup_intent.client_secret;
    } else {
      // Fallback: check latest_invoice confirmation secret
      const invoice = subscription.latest_invoice;
      const cs = invoice ? invoice.confirmation_secret : null;
      clientSecret = cs ? cs.client_secret : null;
    }

    const trialEnd = subscription.trial_end
      ? new Date(subscription.trial_end * 1000).toISOString()
      : null;

    res.json({
      subscriptionId: subscription.id,
      clientSecret,
      status: subscription.status, // should be "trialing"
      trialEnd,
    });
  } catch (err) {
    console.error("Trial subscription error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Fetch the last 5 invoices for the authenticated user directly from Stripe
// We do NOT store invoices in the DB — always query Stripe live.
router.get("/invoices", requireAuth, async (req, res) => {
  try {
    const user = req.user;

    if (!user.stripe_customer_id) {
      return res.json([]);
    }

    const invoiceList = await stripe.invoices.list({
      customer: user.stripe_customer_id,
      limit: 5,
    });

    const invoices = invoiceList.data.map(inv => ({
      id: inv.id,
      number: inv.number,
      status: inv.status,
      amount_due: inv.amount_due,
      amount_paid: inv.amount_paid,
      currency: inv.currency,
      created: inv.created,
      hosted_invoice_url: inv.hosted_invoice_url,
      invoice_pdf: inv.invoice_pdf,
    }));

    res.json(invoices);
  } catch (err) {
    console.error("Invoices fetch error:", err);
    res.status(500).json({ error: err.message });
  }
});

// App 5: Get client secret for an incomplete subscription's payment intent
// Required to render the Stripe Payment Element directly on the Dashboard.
router.get("/incomplete-intent", requireAuth, async (req, res) => {
  try {
    const user = req.user;

    // Fast-fail if there's no subscription assigned
    if (!user.stripe_subscription_id) {
      return res.status(400).json({ error: "No subscription assigned yet." });
    }

    if (user.subscription_status === "active") {
      return res.status(400).json({ error: "Subscription is already active." });
    }

    // Retrieve the subscription from Stripe, expanding both secret types.
    // Newer Stripe API versions use confirmation_secret instead of payment_intent
    // for subscriptions created with price_data.
    const subscription = await stripe.subscriptions.retrieve(
      user.stripe_subscription_id,
      { expand: ["latest_invoice.payment_intent", "latest_invoice.confirmation_secret"] }
    );

    const invoice = subscription.latest_invoice;
    let clientSecret = null;

    if (invoice?.payment_intent?.client_secret) {
      // Classic flow: payment_intent is present and expanded
      clientSecret = invoice.payment_intent.client_secret;
    } else if (invoice?.confirmation_secret?.client_secret) {
      // Newer flow: confirmation_secret is an object with a client_secret
      clientSecret = invoice.confirmation_secret.client_secret;
    }

    if (!clientSecret) {
      return res.status(400).json({ error: "No pending payment intent found." });
    }

    res.json({ clientSecret, amount: user.subscription_amount });
  } catch (err) {
    console.error("Incomplete intent fetch error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
