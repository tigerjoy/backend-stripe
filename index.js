require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const { sequelize } = require("./lib/db");

// Sync Database
sequelize.sync({ alter: true }).then(() => {
  console.log("SQLite Database synced");
}).catch((err) => {
  console.error("Database sync failed:", err);
  process.exit(1); // explicit, intentional exit
});;

const app = express();
app.use(cors());

// Webhooks MUST run before bodyParser/express.json
app.use("/webhooks", require("./routes/webhooks"));

app.use(bodyParser.json());

app.use("/api/users", require("./routes/users").router);
app.use("/api/billing", require("./routes/billing"));

// Endpoint for app 2 (In-app payments)
app.post("/create-payment-intent", async (req, res) => {
  const { amount } = req.body;

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount || 1000,
      currency: "usd",
    });

    res.send({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

// Endpoint for app 3 (Embedded Subscriptions)
app.post("/create-subscription-intent", async (req, res) => {
  const { priceId, email, name } = req.body;

  const user = req.user;

  try {
    // 1. Create a Stripe customer
    // const customer = await stripe.customers.create({
    //   email: email || undefined,
    //   name: name || undefined,
    // });

    // 2. Create an incomplete subscription.
    // Newer Stripe SDK returns the secret via latest_invoice.confirmation_secret
    const subscription = await stripe.subscriptions.create({
      customer: user.stripe_customer_id,
      items: [{ price: priceId }],
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      expand: ["latest_invoice.confirmation_secret.client_secret"],
    });

    const confirmationSecret = subscription.latest_invoice?.confirmation_secret;
    if (!confirmationSecret?.client_secret) {
      return res
        .status(500)
        .send({ error: "Could not retrieve client secret from Stripe." });
    }

    res.send({
      subscriptionId: subscription.id,
      clientSecret: confirmationSecret.client_secret,
      customerId: user.stripe_customer_id,
    });
  } catch (error) {
    console.error("Subscription Error:", error);
    res.status(500).send({ error: error.message });
  }
});

// Endpoint for app 1 (Hosted checkout)
app.post("/create-checkout-session", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      // payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "Sample Product",
            },
            unit_amount: 2000, // $20.00
          },
          quantity: 1,
        },
      ],
      success_url: `${process.env.FRONTEND_URL}/app1/success`,
      cancel_url: `${process.env.FRONTEND_URL}/app1/cancel`,
    });
    res.json({ url: session.url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(4000, () => {
  console.log("Server is running on http://localhost:4000");
}).on("error", (err) => {
  console.error("Server failed to start:", err);
  process.exit(1);
});
