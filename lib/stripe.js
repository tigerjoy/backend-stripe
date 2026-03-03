const Stripe = require("stripe");

// const stripe = Stripe(process.env.STRIPE_SECRET_KEY, {
//   apiVersion: "2024-11-20.acacia",
// });

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = stripe;
