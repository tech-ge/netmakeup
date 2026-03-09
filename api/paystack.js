const express      = require('express');
const https        = require('https');
const User         = require('../models/Users');
const Commission   = require('../models/Commission');
const Notification = require('../models/Notification');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

function paystackRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.paystack.co',
      port: 443,
      path,
      method,
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(new Error('Invalid Paystack response')); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ============================================================
// INITIALIZE PAYMENT — user deposits via Paystack popup
// POST /api/paystack/initialize
// Body: { amount }  (amount in KES)
// Returns: { authorizationUrl, reference }
// ============================================================
router.post('/initialize', authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || parseFloat(amount) <= 0)
      return res.status(400).json({ error: 'Valid amount required.' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const amountKobo = Math.round(parseFloat(amount) * 100); // Paystack uses kobo/cents

    const response = await paystackRequest('POST', '/transaction/initialize', {
      email:        user.email,
      amount:       amountKobo,
      currency:     'KES',
      reference:    `TG-${user._id}-${Date.now()}`,
      callback_url: `${process.env.FRONTEND_URL || 'https://techgeo.co.ke'}/dashboard.html#deposit-success`,
      metadata: {
        userId:   user._id.toString(),
        username: user.username,
        purpose:  'wallet_deposit'
      }
    });

    if (!response.status) return res.status(400).json({ error: response.message || 'Paystack initialization failed.' });

    res.json({
      authorizationUrl: response.data.authorization_url,
      reference:        response.data.reference,
      accessCode:       response.data.access_code
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ============================================================
// VERIFY PAYMENT — called after popup closes or user returns
// POST /api/paystack/verify
// Body: { reference }
// Credits wallet if payment successful
// ============================================================
router.post('/verify', authMiddleware, async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference) return res.status(400).json({ error: 'Reference required.' });

    // Prevent double-credit
    const alreadyProcessed = await Commission.findOne({
      'metadata.paystackReference': reference,
      type: 'deposit'
    });
    if (alreadyProcessed) return res.status(400).json({ error: 'This payment has already been credited.' });

    const response = await paystackRequest('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    if (!response.status || response.data.status !== 'success')
      return res.status(400).json({ error: 'Payment not successful. Please try again or contact support.' });

    const amountKES  = response.data.amount / 100; // convert from kobo back to KES
    const userId     = response.data.metadata?.userId || req.userId;
    const txnRef     = response.data.reference;

    const user = await User.findByIdAndUpdate(
      userId,
      { $inc: { 'primaryWallet.balance': amountKES } },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found.' });

    // Log deposit — also serves as idempotency record
    await Commission.create({
      fromUserId:  user._id,
      toUserId:    user._id,
      level:       0,
      amount:      amountKES,
      type:        'deposit',
      status:      'completed',
      description: `Paystack deposit: KES ${amountKES} | ref: ${txnRef}`,
      metadata:    { paystackReference: txnRef, channel: response.data.channel, paymentMethod: 'paystack' }
    });

    await Notification.create({
      userId:   user._id,
      type:     'deposit_confirmed',
      title:    '✅ Deposit Confirmed',
      message:  `KES ${amountKES} has been added to your wallet. Ref: ${txnRef}`,
      metadata: { amount: amountKES, reference: txnRef }
    }).catch(() => {});

    console.log(`💰 DEPOSIT VERIFIED: KES ${amountKES} → ${user.username} | ref: ${txnRef}`);

    res.json({
      message:    `✅ KES ${amountKES} successfully added to your wallet.`,
      amount:     amountKES,
      newBalance: user.primaryWallet.balance,
      reference:  txnRef
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ============================================================
// WEBHOOK — Paystack server-to-server event (backup credit)
// POST /api/paystack/webhook
// No auth — verified via Paystack signature
// ============================================================
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const crypto = require('crypto');
    const hash   = crypto.createHmac('sha512', PAYSTACK_SECRET)
                         .update(req.body)
                         .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(401).send('Invalid signature');
    }

    const event = JSON.parse(req.body);
    res.sendStatus(200); // Always respond 200 immediately to Paystack

    if (event.event === 'charge.success') {
      const data      = event.data;
      const reference = data.reference;
      const amountKES = data.amount / 100;
      const userId    = data.metadata?.userId;

      if (!userId) return;

      // Idempotency — skip if already credited
      const exists = await Commission.findOne({ 'metadata.paystackReference': reference, type: 'deposit' });
      if (exists) return;

      await User.findByIdAndUpdate(userId, { $inc: { 'primaryWallet.balance': amountKES } });

      await Commission.create({
        fromUserId:  userId, toUserId: userId, level: 0,
        amount:      amountKES, type: 'deposit', status: 'completed',
        description: `Paystack webhook deposit: KES ${amountKES} | ref: ${reference}`,
        metadata:    { paystackReference: reference, channel: data.channel, paymentMethod: 'paystack', source: 'webhook' }
      });

      await Notification.create({
        userId,
        type:     'deposit_confirmed',
        title:    '✅ Deposit Confirmed',
        message:  `KES ${amountKES} has been added to your wallet. Ref: ${reference}`,
        metadata: { amount: amountKES, reference }
      }).catch(() => {});

      console.log(`💰 WEBHOOK DEPOSIT: KES ${amountKES} → userId: ${userId} | ref: ${reference}`);
    }
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.sendStatus(200); // Still 200 — never let Paystack retry unnecessarily
  }
});

module.exports = router;
