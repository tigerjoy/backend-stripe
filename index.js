require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const { sequelize } = require("./lib/db");

// Sync Database
sequelize.sync().then(() => {
  console.log("SQLite Database synced");
});

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
      amount: amount || 1000, // Defaulting if not strictly provided
      currency: "usd",
    });

    res.send({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

// Endpoint for app 1 (Hosted checkout)
app.post("/create-checkout-session", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
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

app.listen(5000, () => {
  console.log("Server is running on http://localhost:5000");
});
