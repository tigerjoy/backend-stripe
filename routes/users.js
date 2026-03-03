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

/**
 * GET /me/billing
 * Read-only billing info for current user
 */
router.get("/me/billing", requireAuth, async (req, res) => {
  try {
    const user = req.user;

    // 1️⃣ Default response from DB (fast path)
    let responseData = {
      status: user.subscription_status || "none",
      plan: user.subscription_plan || null,
      renewsAt: user.current_period_end
        ? new Date(user.current_period_end).toISOString()
        : null,
      trialEnd: user.trial_end ? new Date(user.trial_end).toISOString() : null,
      isActive:
        user.subscription_status === "active" ||
        user.subscription_status === "trialing",
      amount: null,
      currency: null,
      interval: null,
      quantity: null,
    };

    // If user never had Stripe
    if (!user.stripe_customer_id) {
      return res.json(responseData);
    }

    // 2️⃣ Fetch subscription (NO over-expansion)
    const subscriptions = await stripe.subscriptions.list({
      customer: user.stripe_customer_id,
      status: "all",
      limit: 1,
      expand: ["data.items.data.price"], // ✅ exactly 4 levels
    });

    const sub = subscriptions.data?.[0];
    if (!sub) {
      return res.json(responseData);
    }

    const item = sub.items?.data?.[0];
    const price = item?.price;

    // 3️⃣ Extract values safely
    const planName =
      price?.nickname || user.subscription_plan || "Premium Plan";

    const renewsAt = item.current_period_end
      ? new Date(item.current_period_end * 1000).toISOString()
      : null;

    const trialEnd = sub.trial_end
      ? new Date(sub.trial_end * 1000).toISOString()
      : null;

    const isActive = sub.status === "active" || sub.status === "trialing";

    // 4️⃣ Background DB sync (best-effort)
    user
      .update({
        subscription_status: sub.status,
        subscription_plan: planName,
        current_period_end: renewsAt ? new Date(renewsAt) : null,
        trial_end: trialEnd ? new Date(trialEnd) : null,
      })
      .catch(err => console.error("Billing DB sync failed:", err));

    // 5️⃣ Build final response (from Stripe)
    responseData = {
      status: sub.status,
      plan: planName,
      renewsAt,
      trialEnd,
      isActive,
      amount: price?.unit_amount ?? null,
      currency: price?.currency ?? null,
      interval: price?.recurring?.interval ?? null,
      quantity: item?.quantity ?? null,
    };

    return res.json(responseData);
  } catch (err) {
    console.error("Billing fetch error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Read-Only Billing Info
// router.get("/me/billing", requireAuth, async (req, res) => {
//   try {
//     const user = req.user;

//     // Default response values from local DB
//     let responseData = {
//       status: user.subscription_status || "none",
//       plan: user.subscription_plan || null,
//       renewsAt: user.current_period_end || null,
//       isActive:
//         user.subscription_status === "active" ||
//         user.subscription_status === "trialing",
//     };

//     // Fetch freshest data from Stripe directly (ensures accuracy even without webhooks)
//     if (user.stripe_customer_id) {
//       // Stripe allows max 3 levels of expansion
//       const subscriptions = await stripe.subscriptions.list({
//         customer: user.stripe_customer_id,
//         status: "all",
//         expand: ["data.items.data.price"],
//         limit: 1,
//       });

//       if (subscriptions.data.length > 0) {
//         const sub = subscriptions.data[0];

//         // Fetch product name separately (can't go 4 levels deep in expand)
//         let productName = user.subscription_plan || "Premium Plan";
//         const productId = sub.items?.data?.[0]?.price?.product;
//         if (productId && typeof productId === "string") {
//           try {
//             const product = await stripe.products.retrieve(productId);
//             productName = product.name || productName;
//           } catch (_) {
//             /* non-critical, use DB fallback */
//           }
//         }

//         // Derive renewsAt directly from Stripe's Unix timestamp
//         console.log(
//           "[DEBUG] sub.current_period_end:",
//           sub.current_period_end,
//           "| sub.status:",
//           sub.status,
//         );
//         const renewsAt = sub.current_period_end
//           ? new Date(sub.current_period_end * 1000).toISOString()
//           : null;

//         // Persist to DB in the background (best-effort sync)
//         user
//           .update({
//             subscription_status: sub.status,
//             subscription_plan: productName,
//             current_period_end: renewsAt ? new Date(renewsAt) : null,
//           })
//           .catch(err => console.error("DB sync error:", err));

//         // Build response directly from live Stripe data
//         responseData = {
//           status: sub.status,
//           plan: productName,
//           renewsAt,
//           isActive: sub.status === "active" || sub.status === "trialing",
//         };
//       }
//     }

//     res.json(responseData);
//   } catch (err) {
//     console.error("Billing fetch error:", err);
//     res.status(500).json({ error: err.message });
//   }
// });

module.exports = {
  router,
  requireAuth,
};
