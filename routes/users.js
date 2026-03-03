const express = require("express");
const stripe = require("../lib/stripe");
const { User } = require("../lib/db");

const router = express.Router();

// Mock Auth Middleware
const requireAuth = async (req, res, next) => {
  // In a real app you'd read a JWT or session cookie here.
  // For this dummy, we'll pass `userId` in the headers.
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

// Mock Registration
router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    // 1. Create in your DB first
    const user = await User.create({ name, email, password });

    // 2. Create matching Stripe Customer
    const customer = await stripe.customers.create({
      email,
      name,
      metadata: {
        user_id: String(user.id), // crucial for webhooks later or reverse mapping
      },
    });

    // 3. Save the Stripe Customer ID back to your user record
    await user.update({ stripe_customer_id: customer.id });

    // In a real app, send back a JWT. We'll just send the ID.
    return res.json({
      id: user.id,
      email: user.email,
      stripe_customer_id: customer.id,
    });
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Read-Only Billing Info
router.get("/me/billing", requireAuth, async (req, res) => {
  try {
    const user = req.user;
    res.json({
      status: user.subscription_status, // active | past_due | canceled | none
      plan: user.subscription_plan, // "Pro Plan" | null
      renewsAt: user.current_period_end, // Date | null
      isActive:
        user.subscription_status === "active" ||
        user.subscription_status === "trialing",
    });
  } catch (err) {
    console.error("Billing fetch error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = {
  router,
  requireAuth,
};
