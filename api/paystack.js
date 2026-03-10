const express      = require('express');
const https        = require('https');
const User         = require('../models/Users');
const { sendDepositConfirmed } = require('../utils/emailHelper');
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
// INITIALIZE PAYMENT  
// POST /api/paystack/initialize
// Body: { amount }  (amount in KES)
// ============================================================
router.post('/initialize', authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || parseFloat(amount) <= 0)
      return res.status(400).json({ error: 'Valid amount required.' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const amountKobo = Math.round(parseFloat(amount) * 100);

    const response = await paystackRequest('POST', '/transaction/initialize', {
      email:        user.email,
      amount:       amountKobo,
      currency:     'KES',
      reference:    `TG-${user._id}-${Date.now()}`,
      callback_url: `${process.env.FRONTEND_URL || 'https://techgeo.co.ke'}/dashboard.html?deposit=1`,
      metadata: {
        userId:   user._id.toString(),
        username: user.username,
        purpose:  'wallet_deposit'
      }
    });

    if (!response.status)
      return res.status(400).json({ error: response.message || 'Paystack initialization failed.' });

    res.json({
      authorizationUrl: response.data.authorization_url,
      reference:        response.data.reference,
      accessCode:       response.data.access_code,
      email:            user.email   // send back so frontend never has to guess
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// VERIFY PAYMENT
// POST /api/paystack/verify
// Body: { reference }
// ============================================================
router.post('/verify', authMiddleware, async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference) return res.status(400).json({ error: 'Reference required.' });

    // Prevent double-credit
    const alreadyProcessed = await Commission.findOne({
      'metadata.paystackReference': reference,
      'metadata.recordType': 'deposit'
    });
    if (alreadyProcessed)
      return res.status(400).json({ error: 'This payment has already been credited.' });

    // Retry up to 3 times with 2s delay — M-Pesa STK push can briefly show 'pending'
    // Total max wait: ~6s — well within Vercel's 30s maxDuration
    let response, attempts = 0;
    while (attempts < 3) {
      response = await paystackRequest('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
      if (response.status && response.data.status === 'success') break;
      if (response.status && response.data.status === 'abandoned') break; // user cancelled
      attempts++;
      if (attempts < 3) await new Promise(r => setTimeout(r, 2000));
    }
    if (!response.status || response.data.status !== 'success') {
      const ps = response?.data?.status || 'unknown';
      return res.status(400).json({ error: ps === 'abandoned'
        ? 'Payment was cancelled or not completed.'
        : `Payment status: ${ps}. If you were charged, contact support with ref: ${reference}`
      });
    }

    const amountKES = response.data.amount / 100;
    const userId    = response.data.metadata?.userId || req.userId;
    const txnRef    = response.data.reference;

    const user = await User.findByIdAndUpdate(
      userId,
      { $inc: { 'primaryWallet.balance': amountKES } },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found.' });

    try {
      await Commission.create({
        fromUserId:  user._id,
        toUserId:    user._id,
        level:       0,
        amount:      amountKES,
        type:        'deposit',
        status:      'completed',
        description: `Paystack deposit: KES ${amountKES} | ref: ${txnRef}`,
        metadata: {
          paystackReference: txnRef,
          channel:           response.data.channel,
          paymentMethod:     'paystack',
          recordType:        'deposit'
        }
      });
    } catch (logErr) {
      console.error('Deposit log skipped:', logErr.message);
    }

    try {
      await Notification.create({
        userId:   user._id,
        type:     'deposit_confirmed',
        title:    'Deposit Confirmed',
        message:  `KES ${amountKES} has been added to your wallet. Ref: ${txnRef}`,
        metadata: { amount: amountKES, reference: txnRef }
      });
    } catch (notifErr) {
      console.error('Deposit notification skipped:', notifErr.message);
    }

    console.log(`DEPOSIT VERIFIED: KES ${amountKES} -> ${user.username} | ref: ${txnRef}`);

    // Send deposit confirmation email (non-blocking)
    sendDepositConfirmed(user.email, user.username, amountKES, txnRef).catch(() => {});

    res.json({
      message:    `KES ${amountKES} successfully added to your wallet.`,
      amount:     amountKES,
      newBalance: user.primaryWallet.balance,
      reference:  txnRef
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// WEBHOOK — Paystack server-to-server event
// POST /api/paystack/webhook
// app.js already applies express.raw() to this path.
// Do NOT add express.raw() here — that caused the JSON.parse error.
// ============================================================
router.post('/webhook', async (req, res) => {
  try {
    const crypto = require('crypto');

    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));

    const hash = crypto
      .createHmac('sha512', PAYSTACK_SECRET)
      .update(rawBody)
      .digest('hex');

    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(401).send('Invalid signature');
    }

    const event = JSON.parse(rawBody.toString('utf8'));

    res.sendStatus(200);

    if (event.event === 'charge.success') {
      const data      = event.data;
      const reference = data.reference;
      const amountKES = data.amount / 100;
      const userId    = data.metadata && data.metadata.userId;

      if (!userId) return;

      // Prevent double-credit
      const exists = await Commission.findOne({
        'metadata.paystackReference': reference,
        'metadata.recordType':        'deposit'
      });
      if (exists) {
        console.log(`WEBHOOK DEPOSIT DUPLICATE BLOCKED: ref: ${reference}`);
        return;
      }

      // Fetch user and credit wallet
      const user = await User.findByIdAndUpdate(
        userId,
        { $inc: { 'primaryWallet.balance': amountKES } },
        { new: true }
      );

      if (!user) {
        console.error(`WEBHOOK DEPOSIT FAILED: User not found | userId: ${userId} | ref: ${reference}`);
        return;
      }

      // Log deposit
      try {
        await Commission.create({
          fromUserId:  user._id,
          toUserId:    user._id,
          level:       0,
          amount:      amountKES,
          type:        'deposit',
          status:      'completed',
          description: `Paystack webhook deposit: KES ${amountKES} | ref: ${reference}`,
          metadata: {
            paystackReference: reference,
            channel:           data.channel,
            paymentMethod:     'paystack',
            source:            'webhook',
            recordType:        'deposit'
          }
        });
      } catch (logErr) {
        console.error('Webhook deposit log skipped:', logErr.message);
      }

      // Create notification
      try {
        await Notification.create({
          userId:   user._id,
          type:     'deposit_confirmed',
          title:    'Deposit Confirmed',
          message:  `KES ${amountKES} has been added to your wallet. Ref: ${reference}`,
          metadata: { amount: amountKES, reference: reference }
        });
      } catch (notifErr) {
        console.error('Webhook notification skipped:', notifErr.message);
      }

      // Send confirmation email (non-blocking)
      sendDepositConfirmed(user.email, user.username, amountKES, reference).catch(() => {});

      console.log(`WEBHOOK DEPOSIT: KES ${amountKES} -> ${user.username} | ref: ${reference}`);
    }
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.sendStatus(200);
  }
});

module.exports = router;
