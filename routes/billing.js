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

module.exports = router;
