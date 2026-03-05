# Stripe Implementation Guide
## Assign → Notify → Pay → Activate

---

## The Full Flow

```
ADMIN PATH A (Stripe Dashboard)          ADMIN PATH B (Internal Admin Page)
         │                                           │
         └──────────────┬────────────────────────────┘
                        ▼
            Admin creates subscription for user
            with custom price override
            → Stripe sets status: "incomplete"
                        │
                        ▼
            Webhook fires: customer.subscription.created
                        │
                        ▼
            App saves: subscription_status = "incomplete"
                        │
                        ▼
            User logs in → App detects "incomplete"
                        │
                        ▼
            Modal shown: "You have a pending payment of $X/mo"
                        │
                        ▼
            User clicks "Pay Now"
                        │
                        ▼
            App creates Stripe Checkout session
            (tied to the existing subscription)
                        │
                        ▼
            User completes payment on Stripe Checkout
                        │
                        ▼
            Webhook fires: invoice.payment_succeeded
            + customer.subscription.updated
                        │
                        ▼
            App updates: subscription_status = "active"
                        │
                        ▼
            Stripe redirects user → /dashboard
```

---

## Why "incomplete" is the right Stripe status

When an admin creates a subscription without an existing payment method on file,
Stripe sets it to `incomplete`. This is by design:

- The subscription EXISTS in Stripe (admin did their job)
- Payment has NOT been collected yet
- Stripe gives a 23-hour window to complete payment
- After 23 hours without payment → `incomplete_expired`
- Your app watches for this status and gates access accordingly

This is the cleanest pattern for "admin assigns → user pays later".

---

## Database

```sql
-- Add to your existing users table
ALTER TABLE users ADD COLUMN stripe_customer_id      VARCHAR(255) UNIQUE;
ALTER TABLE users ADD COLUMN stripe_subscription_id  VARCHAR(255) UNIQUE;
ALTER TABLE users ADD COLUMN subscription_status     VARCHAR(50) DEFAULT 'none';
-- Possible values: none | incomplete | incomplete_expired | trialing
--                  active | past_due | canceled | unpaid

ALTER TABLE users ADD COLUMN subscription_plan       VARCHAR(100);
ALTER TABLE users ADD COLUMN subscription_amount     INTEGER;
-- Amount in cents, e.g. 2900 = $29.00 — lets you show the user what they owe

ALTER TABLE users ADD COLUMN current_period_end      TIMESTAMP;

CREATE INDEX idx_stripe_customer ON users(stripe_customer_id);
CREATE INDEX idx_stripe_sub      ON users(stripe_subscription_id);
```

---

## One-Time Stripe Dashboard Setup

Do this once. Never again.

**1. Create your Product:**
> Dashboard → Products → + Add product
> - Name: "Platform Access" (or whatever your service is called)
> - Leave pricing blank for now — you'll set it per-customer

**2. Create a default Price (optional but useful):**
> On the same product → + Add price
> - $29/month (or your standard rate)
> - This becomes your starting point; admin overrides it per customer

**3. Enable Customer Portal:**
> Dashboard → Settings → Billing → Customer Portal → Activate
> Check: Invoice history, Cancel subscription, Update payment method

**4. Configure Webhooks:**
> Dashboard → Developers → Webhooks → + Add endpoint
> - URL: `https://yourdomain.com/webhooks/stripe`
> - Select events:
>   - `customer.subscription.created`
>   - `customer.subscription.updated`
>   - `customer.subscription.deleted`
>   - `invoice.payment_succeeded`
>   - `invoice.payment_failed`
> - Copy the Signing Secret → `STRIPE_WEBHOOK_SECRET` in your .env

---

## Admin Path A: Assign from Stripe Dashboard

This requires zero code. Here's the exact steps the admin follows:

**To assign a subscription with custom price:**

1. Dashboard → Customers → search by email
2. Click the customer → "+ Create subscription"
3. Search for "Platform Access" (your product)
4. Click the price field → select your default price
5. **Click the pencil icon next to the price → enter custom amount**
   - e.g. type `49` for $49/month for this specific customer
   - This overrides JUST for this customer — the product stays the same
6. Under "Payment" → select **"Send invoice"** or **"Charge automatically"**
   - Choose **"Send invoice"** → this sets status to `incomplete`, user pays later
7. Click "Start subscription"

Stripe creates the subscription → fires webhook → your app updates the user's status to `incomplete` → user sees the payment modal on next login.

**That's it. No new products. No new prices. One product, custom amount per customer.**

---

## Admin Path B: Internal Admin Page

A small React + Express page inside your app. Admin searches a user,
enters a price, clicks Assign. Your backend creates the subscription via API.

### Backend — Admin Route

```js
// routes/admin.js
const stripe = require('../lib/stripe');
const db = require('../lib/db');
const router = require('express').Router();

/**
 * GET /admin/users
 * Search users with their current billing status
 */
router.get('/users', requireAdmin, async (req, res) => {
  const { search } = req.query;
  const where = search
    ? { [Op.or]: [{ email: { [Op.iLike]: `%${search}%` } }, { name: { [Op.iLike]: `%${search}%` } }] }
    : {};

  const users = await db.users.findAll({
    where,
    attributes: ['id', 'name', 'email', 'stripe_customer_id',
                 'subscription_status', 'subscription_plan', 'subscription_amount'],
    limit: 50,
    order: [['created_at', 'DESC']],
  });

  res.json(users);
});

/**
 * POST /admin/users/:id/subscription
 * Assign a subscription with a custom price to a user
 * Body: { amountCents: 2900 }  ← e.g. 2900 = $29.00/month
 */
router.post('/users/:id/subscription', requireAdmin, async (req, res) => {
  const { amountCents } = req.body;

  if (!amountCents || amountCents < 100) {
    return res.status(400).json({ error: 'Amount must be at least $1.00 (100 cents)' });
  }

  const user = await db.users.findByPk(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.stripe_customer_id) return res.status(400).json({ error: 'User has no Stripe customer' });

  // Cancel existing subscription if any
  if (user.stripe_subscription_id) {
    await stripe.subscriptions.cancel(user.stripe_subscription_id).catch(() => {});
  }

  // Create subscription with custom price inline
  // Uses your single Product but sets a custom unit_amount for this customer only
  const subscription = await stripe.subscriptions.create({
    customer: user.stripe_customer_id,
    items: [{
      price_data: {
        currency: 'usd',
        product: process.env.STRIPE_PRODUCT_ID,  // your single Product ID
        unit_amount: amountCents,
        recurring: { interval: 'month' },
      },
    }],
    payment_behavior: 'default_incomplete',  // → sets status to "incomplete"
    payment_settings: { save_default_payment_method: 'on_subscription' },
    expand: ['latest_invoice.payment_intent'],
  });

  // Optimistically update DB (webhook will also confirm this)
  await db.users.update(
    {
      stripe_subscription_id: subscription.id,
      subscription_status: 'incomplete',
      subscription_amount: amountCents,
    },
    { where: { id: user.id } }
  );

  res.json({
    success: true,
    subscriptionId: subscription.id,
    status: subscription.status,
    amount: amountCents,
  });
});

/**
 * DELETE /admin/users/:id/subscription
 * Cancel a user's subscription immediately
 */
router.delete('/users/:id/subscription', requireAdmin, async (req, res) => {
  const user = await db.users.findByPk(req.params.id);
  if (!user?.stripe_subscription_id) return res.status(404).json({ error: 'No subscription found' });

  await stripe.subscriptions.cancel(user.stripe_subscription_id);

  await db.users.update(
    { subscription_status: 'canceled', stripe_subscription_id: null },
    { where: { id: user.id } }
  );

  res.json({ success: true });
});

module.exports = router;
```

### Frontend — Admin Page (React)

```jsx
// pages/admin/Billing.jsx
import { useState, useEffect } from 'react';

export default function AdminBilling() {
  const [search, setSearch]   = useState('');
  const [users, setUsers]     = useState([]);
  const [loading, setLoading] = useState(false);
  const [assigning, setAssigning] = useState(null); // userId being assigned
  const [amount, setAmount]   = useState('');       // dollar amount input

  useEffect(() => {
    const timer = setTimeout(() => fetchUsers(), 300);
    return () => clearTimeout(timer);
  }, [search]);

  async function fetchUsers() {
    setLoading(true);
    const res = await fetch(`/admin/users?search=${encodeURIComponent(search)}`,
      { headers: { Authorization: `Bearer ${getToken()}` } });
    setUsers(await res.json());
    setLoading(false);
  }

  async function assignSubscription(userId) {
    const cents = Math.round(parseFloat(amount) * 100);
    if (!cents || cents < 100) return alert('Enter a valid amount (minimum $1.00)');

    const res = await fetch(`/admin/users/${userId}/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ amountCents: cents }),
    });

    if (res.ok) {
      alert('Subscription assigned. User will see payment prompt on next login.');
      setAssigning(null);
      setAmount('');
      fetchUsers();
    } else {
      const err = await res.json();
      alert(`Error: ${err.error}`);
    }
  }

  async function cancelSubscription(userId) {
    if (!confirm('Cancel this subscription?')) return;
    await fetch(`/admin/users/${userId}/subscription`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    fetchUsers();
  }

  const statusColor = {
    active:             '#16a34a',
    incomplete:         '#d97706',
    incomplete_expired: '#dc2626',
    past_due:           '#dc2626',
    canceled:           '#6b7280',
    none:               '#9ca3af',
  };

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '32px 24px' }}>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 24 }}>Billing — User Management</h1>

      <input
        placeholder="Search by name or email..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ width: '100%', padding: '10px 14px', borderRadius: 8,
                 border: '1px solid #e5e7eb', fontSize: 14, marginBottom: 24 }}
      />

      {loading && <p style={{ color: '#9ca3af' }}>Loading...</p>}

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #f3f4f6', textAlign: 'left' }}>
            <th style={{ padding: '8px 12px', color: '#6b7280', fontWeight: 500 }}>User</th>
            <th style={{ padding: '8px 12px', color: '#6b7280', fontWeight: 500 }}>Status</th>
            <th style={{ padding: '8px 12px', color: '#6b7280', fontWeight: 500 }}>Amount</th>
            <th style={{ padding: '8px 12px', color: '#6b7280', fontWeight: 500 }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map(user => (
            <tr key={user.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
              <td style={{ padding: '12px' }}>
                <div style={{ fontWeight: 500 }}>{user.name}</div>
                <div style={{ color: '#9ca3af', fontSize: 12 }}>{user.email}</div>
              </td>
              <td style={{ padding: '12px' }}>
                <span style={{
                  color: statusColor[user.subscription_status] || '#9ca3af',
                  fontWeight: 500, fontSize: 13,
                }}>
                  {user.subscription_status || 'none'}
                </span>
              </td>
              <td style={{ padding: '12px', color: '#374151' }}>
                {user.subscription_amount
                  ? `$${(user.subscription_amount / 100).toFixed(2)}/mo`
                  : '—'}
              </td>
              <td style={{ padding: '12px' }}>
                {assigning === user.id ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ color: '#6b7280', fontSize: 13 }}>$</span>
                    <input
                      type="number"
                      placeholder="29.00"
                      value={amount}
                      onChange={e => setAmount(e.target.value)}
                      style={{ width: 80, padding: '6px 8px', borderRadius: 6,
                               border: '1px solid #e5e7eb', fontSize: 13 }}
                      autoFocus
                    />
                    <span style={{ color: '#6b7280', fontSize: 12 }}>/mo</span>
                    <button onClick={() => assignSubscription(user.id)}
                      style={{ padding: '6px 14px', background: '#111827', color: '#fff',
                               border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
                      Confirm
                    </button>
                    <button onClick={() => { setAssigning(null); setAmount(''); }}
                      style={{ padding: '6px 12px', background: 'transparent', color: '#6b7280',
                               border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => setAssigning(user.id)}
                      style={{ padding: '6px 14px', background: '#111827', color: '#fff',
                               border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
                      {user.subscription_status === 'active' ? 'Change price' : 'Assign'}
                    </button>
                    {user.stripe_subscription_id && (
                      <button onClick={() => cancelSubscription(user.id)}
                        style={{ padding: '6px 12px', background: 'transparent', color: '#dc2626',
                                 border: '1px solid #fca5a5', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
                        Cancel
                      </button>
                    )}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

---

## Webhook Handler

```js
// routes/webhooks.js
const stripe = require('../lib/stripe');
const db = require('../lib/db');
const router = require('express').Router();

router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await syncSubscription(event.data.object);
        break;

      case 'customer.subscription.deleted':
        await syncSubscription(event.data.object); // status will be "canceled"
        break;

      case 'invoice.payment_succeeded':
        // Subscription transitions from incomplete → active here
        if (event.data.object.subscription) {
          await db.users.update(
            { subscription_status: 'active' },
            { where: { stripe_subscription_id: event.data.object.subscription } }
          );
        }
        break;

      case 'invoice.payment_failed':
        if (event.data.object.subscription) {
          await db.users.update(
            { subscription_status: 'past_due' },
            { where: { stripe_subscription_id: event.data.object.subscription } }
          );
        }
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: 'Handler failed' });
  }
});

async function syncSubscription(subscription) {
  // Pull plan name and amount from Stripe
  const item = subscription.items.data[0];
  let planName = null;
  let amountCents = null;

  if (item) {
    amountCents = item.price.unit_amount;
    const price = await stripe.prices.retrieve(item.price.id, { expand: ['product'] });
    planName = price.product.name;
  }

  await db.users.update(
    {
      stripe_subscription_id: subscription.id,
      subscription_status:    subscription.status,
      subscription_plan:      planName,
      subscription_amount:    amountCents,
      current_period_end: subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000)
        : null,
    },
    { where: { stripe_customer_id: subscription.customer } }
  );
}

module.exports = router;
```

---

## Payment Modal — Backend Route

```js
// routes/billing.js
const stripe = require('../lib/stripe');
const db = require('../lib/db');
const router = require('express').Router();

/**
 * POST /billing/checkout
 * Creates a Stripe Checkout session for the user's pending (incomplete) subscription
 */
router.post('/checkout', requireAuth, async (req, res) => {
  const user = await db.users.findByPk(req.user.id);

  if (!user.stripe_subscription_id) {
    return res.status(400).json({ error: 'No subscription assigned yet. Contact support.' });
  }

  if (user.subscription_status === 'active') {
    return res.status(400).json({ error: 'Subscription is already active.' });
  }

  // Retrieve the subscription to get the invoice's payment intent
  const subscription = await stripe.subscriptions.retrieve(
    user.stripe_subscription_id,
    { expand: ['latest_invoice.payment_intent'] }
  );

  const paymentIntent = subscription.latest_invoice?.payment_intent;
  if (!paymentIntent) {
    return res.status(400).json({ error: 'No payment required at this time.' });
  }

  // Create a Checkout session in "payment" mode tied to the existing subscription invoice
  const session = await stripe.checkout.sessions.create({
    customer: user.stripe_customer_id,
    mode: 'payment',
    payment_intent_data: {
      // Attach payment to the existing subscription's payment intent
      setup_future_usage: 'off_session',
    },
    line_items: [{
      price_data: {
        currency: 'usd',
        product: process.env.STRIPE_PRODUCT_ID,
        unit_amount: user.subscription_amount,
      },
      quantity: 1,
    }],
    success_url: `${process.env.APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${process.env.APP_URL}/dashboard`,
    metadata: {
      subscription_id: user.stripe_subscription_id,
      user_id: String(user.id),
    },
  });

  res.json({ url: session.url });
});

/**
 * GET /billing/success
 * Stripe redirects here after successful payment.
 * Verify payment and redirect to dashboard.
 * (Webhook will also fire — this is just a fast redirect handler)
 */
router.get('/success', requireAuth, async (req, res) => {
  const { session_id } = req.query;

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status === 'paid') {
      // Optimistically mark active — webhook will also confirm
      await db.users.update(
        { subscription_status: 'active' },
        { where: { id: req.user.id } }
      );
    }
  } catch (err) {
    console.error('Success handler error:', err);
  }

  // Always redirect to dashboard — webhook is the source of truth
  res.redirect(`${process.env.APP_URL}/dashboard`);
});

/**
 * GET /billing/status
 * Used by the frontend to check if modal should be shown
 */
router.get('/status', requireAuth, async (req, res) => {
  const user = await db.users.findByPk(req.user.id, {
    attributes: ['subscription_status', 'subscription_plan',
                 'subscription_amount', 'current_period_end'],
  });

  res.json({
    status:      user.subscription_status,
    plan:        user.subscription_plan,
    amount:      user.subscription_amount,          // cents
    amountFormatted: user.subscription_amount
      ? `$${(user.subscription_amount / 100).toFixed(2)}`
      : null,
    renewsAt:    user.current_period_end,
    isActive:    ['active', 'trialing'].includes(user.subscription_status),
    needsPayment: user.subscription_status === 'incomplete',
    isExpired:   user.subscription_status === 'incomplete_expired',
  });
});

module.exports = router;
```

---

## Payment Modal — React Component

Show this on any protected page (e.g. inside your app layout).

```jsx
// components/PaymentModal.jsx
import { useState, useEffect } from 'react';

export default function PaymentModal() {
  const [billing, setBilling] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/billing/status', { headers: { Authorization: `Bearer ${getToken()}` } })
      .then(r => r.json())
      .then(setBilling);
  }, []);

  async function handlePay() {
    setLoading(true);
    const res = await fetch('/billing/checkout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    const data = await res.json();
    if (data.url) {
      window.location.href = data.url; // redirect to Stripe Checkout
    } else {
      alert(data.error || 'Something went wrong');
      setLoading(false);
    }
  }

  // Only show if subscription is incomplete (assigned but unpaid)
  if (!billing?.needsPayment) return null;

  return (
    // Overlay
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 9999,
    }}>
      <div style={{
        background: '#fff', borderRadius: 16, padding: '40px 36px',
        maxWidth: 440, width: '90%', textAlign: 'center',
        boxShadow: '0 25px 50px rgba(0,0,0,0.15)',
      }}>
        {/* Icon */}
        <div style={{ fontSize: 40, marginBottom: 16 }}>💳</div>

        <h2 style={{ fontSize: 22, fontWeight: 700, color: '#111827', marginBottom: 8 }}>
          Complete your subscription
        </h2>

        <p style={{ fontSize: 15, color: '#6b7280', lineHeight: 1.6, marginBottom: 24 }}>
          Your account has been set up with a{' '}
          <strong style={{ color: '#111827' }}>
            {billing.plan || 'Platform Access'}
          </strong>{' '}
          subscription at{' '}
          <strong style={{ color: '#111827' }}>
            {billing.amountFormatted}/month
          </strong>
          . Complete payment to activate your account.
        </p>

        <button
          onClick={handlePay}
          disabled={loading}
          style={{
            width: '100%', padding: '14px', background: '#111827',
            color: '#fff', border: 'none', borderRadius: 10,
            fontSize: 16, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.7 : 1, marginBottom: 12,
          }}
        >
          {loading ? 'Redirecting to payment...' : `Pay ${billing.amountFormatted}/month →`}
        </button>

        <p style={{ fontSize: 12, color: '#9ca3af' }}>
          Secured by Stripe. You can cancel anytime.
        </p>
      </div>
    </div>
  );
}
```

```jsx
// layouts/AppLayout.jsx — add modal to your main layout
import PaymentModal from '../components/PaymentModal';

export default function AppLayout({ children }) {
  return (
    <>
      <PaymentModal />   {/* ← shows automatically if payment is pending */}
      <Navbar />
      <main>{children}</main>
    </>
  );
}
```

---

## Route Registration (app.js)

```js
// app.js
const express = require('express');
const app = express();

// ⚠️ Webhooks MUST be registered before express.json()
// because Stripe needs the raw body for signature verification
app.use('/webhooks', require('./routes/webhooks'));

app.use(express.json());

app.use('/admin',   require('./routes/admin'));
app.use('/billing', require('./routes/billing'));
app.use('/users',   require('./routes/users'));
```

---

## Environment Variables

```env
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...        # Stripe Dashboard → Developers → Webhooks
STRIPE_PRODUCT_ID=prod_...             # Your single "Platform Access" product ID
APP_URL=https://yourdomain.com
```

---

## Status Reference

| Status | Meaning | What user sees |
|---|---|---|
| `none` | No subscription assigned yet | Normal app access (or gated — your call) |
| `incomplete` | Assigned, not paid yet | Payment modal |
| `incomplete_expired` | 23hr window passed unpaid | "Contact support" message |
| `trialing` | Free trial period | Normal access |
| `active` | Paid and current | Full access |
| `past_due` | Payment failed, Stripe retrying | Warning banner |
| `canceled` | Subscription ended | Access revoked |
| `unpaid` | Stripe gave up retrying | Access revoked |

---

## Files Created / Modified

```
routes/
  webhooks.js      ← Stripe event handler (sync to DB)
  billing.js       ← /checkout, /success, /status
  admin.js         ← /admin/users, assign/cancel subscription

components/
  PaymentModal.jsx ← shown automatically when status = incomplete

pages/admin/
  Billing.jsx      ← internal admin page (Path B)

layouts/
  AppLayout.jsx    ← add <PaymentModal /> here

app.js             ← register routes (webhooks before json middleware)

.env               ← add STRIPE_PRODUCT_ID
```