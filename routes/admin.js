const express = require("express");
const stripe = require("../lib/stripe");
const { User } = require("../lib/db");

const router = express.Router();

// Mock Admin Middleware
const requireAdmin = async (req, res, next) => {
  // In a real app you'd check roles. Here we'll just require a user ID.
  const userId = req.headers["x-user-id"];
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const user = await User.findByPk(userId);
  if (!user) {
    return res.status(401).json({ error: "User not found" });
  }
  req.user = user;
  next();
};

/**
 * GET /admin/users
 * Search users with their current billing status
 */
router.get("/users", requireAdmin, async (req, res) => {
  try {
    const users = await User.findAll({
      attributes: [
        "id",
        "name",
        "email",
        "stripe_customer_id",
        "stripe_subscription_id",
        "subscription_status",
        "subscription_plan",
        "subscription_amount",
      ],
      limit: 50,
      order: [["createdAt", "DESC"]],
    });

    res.json(users);
  } catch (err) {
    console.error("Fetch users error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /admin/users/:id/subscription
 * Assign a subscription with a custom price to a user
 */
router.post("/users/:id/subscription", requireAdmin, async (req, res) => {
  try {
    const { amountCents } = req.body;

    if (!amountCents || amountCents < 100) {
      return res
        .status(400)
        .json({ error: "Amount must be at least $1.00 (100 cents)" });
    }

    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.stripe_customer_id)
      return res.status(400).json({ error: "User has no Stripe customer" });

    // Cancel existing subscription if any
    if (user.stripe_subscription_id) {
      await stripe.subscriptions
        .cancel(user.stripe_subscription_id)
        .catch(() => {});
    }

    // Create subscription with custom price inline
    // Uses a dummy product or generic product id if set, else uses the first available active product
    let productId = process.env.STRIPE_PRODUCT_ID;
    if (!productId) {
      // Find a default product
      const products = await stripe.products.list({ limit: 1, active: true });
      if (products.data.length > 0) {
        productId = products.data[0].id;
      } else {
        // Create a generic product on the fly
        const genericProduct = await stripe.products.create({
          name: "Platform Access",
        });
        productId = genericProduct.id;
      }
    }

    const subscription = await stripe.subscriptions.create({
      customer: user.stripe_customer_id,
      items: [
        {
          price_data: {
            currency: "usd",
            product: productId,
            unit_amount: amountCents,
            recurring: { interval: "month" },
          },
        },
      ],
      payment_behavior: "default_incomplete", // Sets status to "incomplete"
      payment_settings: { save_default_payment_method: "on_subscription" },
      expand: ["latest_invoice.payment_intent"],
    });

    // Optimistically update DB
    await user.update({
      stripe_subscription_id: subscription.id,
      subscription_status: "incomplete",
      subscription_amount: amountCents,
      subscription_plan: "Platform Access",
    });

    res.json({
      success: true,
      subscriptionId: subscription.id,
      status: subscription.status,
      amount: amountCents,
    });
  } catch (err) {
    console.error("Assign subscription error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /admin/users/:id/subscription
 * Cancel a user's subscription immediately
 */
router.delete("/users/:id/subscription", requireAdmin, async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user?.stripe_subscription_id)
      return res.status(404).json({ error: "No subscription found" });

    await stripe.subscriptions.cancel(user.stripe_subscription_id);

    await user.update({
      subscription_status: "canceled",
      stripe_subscription_id: null,
      subscription_amount: null,
      subscription_plan: null,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Cancel subscription error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
