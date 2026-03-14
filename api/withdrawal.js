const express    = require('express');
const Withdrawal = require('../models/Withdrawal');
const User       = require('../models/Users');
const Commission = require('../models/Commission');
const Notification = require('../models/Notification');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { sendWithdrawalSubmitted, sendWithdrawalPaid, sendWithdrawalRejected } = require('../utils/emailHelper');

const router = express.Router();

// ─── EAT (UTC+3)helpers ──────────────────────────────────────────────────────
function nowEAT()    { return new Date(Date.now() + 3 * 60 * 60 * 1000); }
function getEATDay() { return nowEAT().getUTCDay(); }
function eatDayBounds() {
  const eat = nowEAT();
  const eatMidnight = new Date(eat); eatMidnight.setUTCHours(0,0,0,0);
  const startUTC = new Date(eatMidnight.getTime() - 3*60*60*1000);
  const endUTC   = new Date(startUTC.getTime() + 24*60*60*1000 - 1);
  return { startUTC, endUTC };
}
const isTuesday  = () => getEATDay() === 2;
const isThursday = () => getEATDay() === 4;
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

async function safeNotify(payload) {
  try { await Notification.create(payload); } catch(e) { console.error('Notify skipped:', e.message); }
}

// ============================================================
// POINTS WITHDRAWAL REQUEST (Tuesdays EAT)
// Points are NOT deducted yet — held until admin approves
// ============================================================
router.post('/points', authMiddleware, async (req, res) => {
  try {
    const { paymentMethod, paymentDetails } = req.body;
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.packageType === 'not_active' || user.status !== 'active')
      return res.status(400).json({ error: 'Activate your package before withdrawing points.' });

    if (!isTuesday())
      return res.status(400).json({ error: 'Points withdrawals are only processed on Tuesdays (EAT).', today: DAYS[getEATDay()], nextWithdrawalDay: 'Tuesday' });

    if (user.pointsWallet.points < 2000)
      return res.status(400).json({ error: `You need at least 2,000 points to withdraw. You have: ${user.pointsWallet.points}`, required: 2000, current: user.pointsWallet.points });

    const newReferrals = user.pointsWallet.referralsSinceLastWithdrawal || 0;
    if (newReferrals < 4)
      return res.status(400).json({ error: `You need 4 new referrals since your last points withdrawal. You have: ${newReferrals}`, required: 4, current: newReferrals });

    const { startUTC, endUTC } = eatDayBounds();
    const existing = await Withdrawal.findOne({ userId: user._id, type: 'points', requestedAt: { $gte: startUTC, $lte: endUTC } });
    if (existing) return res.status(400).json({ error: 'You have already submitted a points withdrawal request today.', existing: { amount: existing.amount, pointsRedeemed: existing.pointsRedeemed, status: existing.status } });

    if (!paymentMethod || !['mpesa','bank'].includes(paymentMethod))
      return res.status(400).json({ error: 'Valid payment method required (mpesa or bank).' });
    if (paymentMethod === 'mpesa' && !paymentDetails?.mpesaPhone)
      return res.status(400).json({ error: 'M-Pesa phone number required.' });
    if (paymentMethod === 'bank' && (!paymentDetails?.accountNumber || !paymentDetails?.accountName))
      return res.status(400).json({ error: 'Bank account details required.' });

    const totalPoints  = user.pointsWallet.points;
    const redeemable   = Math.floor(totalPoints / 100) * 100;
    const kesValue     = (redeemable / 100) * 10;
    if (redeemable === 0) return res.status(400).json({ error: 'Not enough points for a full 100-point redemption unit.' });

    // ── Points stay in wallet — only create a PENDING request ──
    const withdrawal = await Withdrawal.create({
      userId: user._id, type: 'points',
      amount: kesValue, pointsRedeemed: redeemable,
      paymentMethod, paymentDetails,
      status: 'pending', requestedAt: new Date()
    });

    // FIX: 'withdrawal_requested' is not in Notification schema enum — changed to 'system'
    await safeNotify({ userId: user._id, type: 'system', title: '⏳ Points Withdrawal Requested',
      message: `Your request to redeem ${redeemable} pts → KES ${kesValue} is pending admin approval.`,
      metadata: { withdrawalId: withdrawal._id } });

    console.log(`🎯 POINTS WITHDRAWAL REQUEST: ${redeemable} pts → KES ${kesValue} for ${user.username} | pending admin approval`);
    sendWithdrawalSubmitted(user.email, user.username, kesValue, 'points', withdrawal._id.toString()).catch(() => {});

    res.status(201).json({
      message: `✅ Request submitted. KES ${kesValue} will be sent after admin approval.`,
      withdrawal: { id: withdrawal._id, type: 'points', pointsRedeemed: redeemable, kesValue, status: 'pending', requestedAt: withdrawal.requestedAt },
      currentPoints: user.pointsWallet.points
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ============================================================
// KES WALLET WITHDRAWAL REQUEST (Thursdays EAT)
// Balance is NOT deducted yet — held until admin approves
// ============================================================
router.post('/kes', authMiddleware, async (req, res) => {
  try {
    const { amount, paymentMethod, paymentDetails } = req.body;
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.packageType === 'not_active' || user.status !== 'active')
      return res.status(400).json({ error: 'Activate your package before withdrawing.' });

    if (!isThursday())
      return res.status(400).json({ error: 'KES wallet withdrawals are only processed on Thursdays (EAT).', today: DAYS[getEATDay()], nextWithdrawalDay: 'Thursday' });

    const withdrawAmount = parseFloat(amount);
    if (!withdrawAmount || withdrawAmount < 300)
      return res.status(400).json({ error: 'Minimum KES withdrawal is KES 300.' });
    if (withdrawAmount > user.primaryWallet.balance)
      return res.status(400).json({ error: 'Insufficient KES balance.', available: user.primaryWallet.balance, requested: withdrawAmount });

    const { startUTC, endUTC } = eatDayBounds();
    const existing = await Withdrawal.findOne({ userId: user._id, type: 'kes', requestedAt: { $gte: startUTC, $lte: endUTC } });
    if (existing) return res.status(400).json({ error: 'You have already submitted a KES withdrawal request today.', existing: { amount: existing.amount, status: existing.status } });

    if (!paymentMethod || !['mpesa','bank'].includes(paymentMethod))
      return res.status(400).json({ error: 'Valid payment method required (mpesa or bank).' });
    if (paymentMethod === 'mpesa' && !paymentDetails?.mpesaPhone)
      return res.status(400).json({ error: 'M-Pesa phone number required.' });
    if (paymentMethod === 'bank' && (!paymentDetails?.accountNumber || !paymentDetails?.accountName))
      return res.status(400).json({ error: 'Bank account details required.' });

    // ── Balance stays in wallet — only create a PENDING request ──
    const withdrawal = await Withdrawal.create({
      userId: user._id, type: 'kes',
      amount: withdrawAmount, paymentMethod, paymentDetails,
      status: 'pending', requestedAt: new Date()
    });

    await safeNotify({ userId: user._id, type: 'withdrawal_requested', title: '⏳ KES Withdrawal Requested',
      message: `Your KES ${withdrawAmount} withdrawal request is pending admin approval.`,
      metadata: { withdrawalId: withdrawal._id } });

    console.log(`💸 KES WITHDRAWAL REQUEST: KES ${withdrawAmount} from ${user.username} | pending admin approval`);
    sendWithdrawalSubmitted(user.email, user.username, withdrawAmount, 'kes', withdrawal._id.toString()).catch(() => {});

    res.status(201).json({
      message: '✅ Withdrawal request submitted. Pending admin approval.',
      withdrawal: { id: withdrawal._id, type: 'kes', amount: withdrawAmount, status: 'pending', requestedAt: withdrawal.requestedAt },
      currentBalance: user.primaryWallet.balance
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ============================================================
// USER — own withdrawal history
// ============================================================
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find({ userId: req.userId }).sort({ requestedAt: -1 });
    res.json({
      withdrawals: withdrawals.map(w => ({
        id: w._id, type: w.type, amount: w.amount,
        pointsRedeemed: w.pointsRedeemed || 0, status: w.status,
        paymentMethod: w.paymentMethod, paymentDetails: w.paymentDetails,
        requestedAt: w.requestedAt, processedAt: w.processedAt,
        transactionReference: w.transactionReference, adminNotes: w.adminNotes
      })),
      summary: {
        totalKesWithdrawn:      withdrawals.filter(w => w.type==='kes'    && w.status==='completed').reduce((s,w)=>s+w.amount,0),
        totalPointsWithdrawn:   withdrawals.filter(w => w.type==='points'               ).reduce((s,w)=>s+(w.pointsRedeemed||0),0),
        totalPointsKesReceived: withdrawals.filter(w => w.type==='points' && w.status==='completed').reduce((s,w)=>s+w.amount,0),
        pending:                withdrawals.filter(w => w.status==='pending').length
      }
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ============================================================
// ADMIN — all withdrawals
// ============================================================
router.get('/admin/all', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { status, type } = req.query;
    const query = {};
    if (status) query.status = status;
    if (type && ['kes','points'].includes(type)) query.type = type;
    const withdrawals = await Withdrawal.find(query).sort({ requestedAt: -1 }).populate('userId', 'username email phone');
    res.json({
      withdrawals: withdrawals.map(w => ({
        id: w._id, type: w.type,
        userId: w.userId._id, username: w.userId.username, email: w.userId.email, phone: w.userId.phone,
        amount: w.amount, pointsRedeemed: w.pointsRedeemed || 0, status: w.status,
        paymentMethod: w.paymentMethod, paymentDetails: w.paymentDetails,
        requestedAt: w.requestedAt, processedAt: w.processedAt,
        adminNotes: w.adminNotes, transactionReference: w.transactionReference
      }))
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ============================================================
// ADMIN — APPROVE withdrawal
// This is where money/points are actually deducted and user is paid
// ============================================================
router.post('/admin/:id/complete', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { adminNotes, transactionCode } = req.body;
    if (!transactionCode || !transactionCode.trim())
      return res.status(400).json({ error: 'Transaction code is required before approving.' });

    const withdrawal = await Withdrawal.findById(req.params.id).populate('userId');
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
    if (withdrawal.status !== 'pending') return res.status(400).json({ error: `Cannot approve a ${withdrawal.status} withdrawal.` });

    const userId = withdrawal.userId._id;

    if (withdrawal.type === 'kes') {
      // Deduct from wallet now — verify balance still sufficient
      const updatedUser = await User.findOneAndUpdate(
        { _id: userId, 'primaryWallet.balance': { $gte: withdrawal.amount }, 'primaryWallet.locked': false },
        { $inc: { 'primaryWallet.balance': -withdrawal.amount } },
        { new: true }
      );
      if (!updatedUser) return res.status(400).json({ error: 'Insufficient balance or wallet locked. Cannot process.' });

    } else {
      // Points withdrawal — deduct points atomically now
      const redeemable = withdrawal.pointsRedeemed;
      const updatedUser = await User.findOneAndUpdate(
        { _id: userId, 'pointsWallet.points': { $gte: redeemable } },
        {
          $inc: { 'pointsWallet.points': -redeemable },
          $set: {
            'pointsWallet.referralsSinceLastWithdrawal': 0,
            'pointsWallet.lastWithdrawalAt': new Date()
          }
        },
        { new: true }
      );
      if (!updatedUser) return res.status(400).json({ error: 'User no longer has enough points. Cannot process.' });

      await Commission.create({
        fromUserId: userId, toUserId: userId, level: 1,
        amount: withdrawal.amount, type: 'points_withdrawal_payout', status: 'completed',
        description: `Points withdrawal: ${redeemable} pts → KES ${withdrawal.amount} (profit pool)`,
        metadata: { withdrawalId: withdrawal._id, pointsRedeemed: redeemable, transactionCode }
      });
    }

    withdrawal.status               = 'completed';
    withdrawal.processedAt          = new Date();
    withdrawal.completedAt          = new Date();
    withdrawal.adminNotes           = adminNotes || 'Approved and processed by admin';
    withdrawal.transactionReference = transactionCode.trim();
    await withdrawal.save();

    await safeNotify({ userId,
      type: 'withdrawal_paid', title: '💸 Withdrawal Approved & Paid!',
      message: withdrawal.type === 'points'
        ? `Your points withdrawal of KES ${withdrawal.amount} has been sent to your ${withdrawal.paymentMethod}. Transaction code: ${transactionCode}`
        : `Your KES ${withdrawal.amount} withdrawal has been sent to your ${withdrawal.paymentMethod}. Transaction code: ${transactionCode}`,
      metadata: { withdrawalId: withdrawal._id, amount: withdrawal.amount, type: withdrawal.type, transactionCode }
    });

    // Email user — paid
    const paidUser = withdrawal.userId;
    sendWithdrawalPaid(paidUser.email, paidUser.username, withdrawal.amount, withdrawal.type, transactionCode, withdrawal.paymentMethod).catch(() => {});

    res.json({
      message: 'Withdrawal approved and processed.',
      withdrawal: { id: withdrawal._id, status: 'completed', type: withdrawal.type, transactionCode }
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ============================================================
// ADMIN — REJECT withdrawal
// Since money was never deducted, just mark rejected and notify
// ============================================================
router.post('/admin/:id/reject', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { adminNotes } = req.body;
    const withdrawal = await Withdrawal.findById(req.params.id).populate('userId');
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
    if (withdrawal.status !== 'pending') return res.status(400).json({ error: `Cannot reject a ${withdrawal.status} withdrawal.` });

    // Money was never deducted on request — refund only needed if somehow already processed
    // But since we hold until approve, nothing to refund — just mark rejected
    withdrawal.status      = 'rejected';
    withdrawal.processedAt = new Date();
    withdrawal.adminNotes  = adminNotes || 'Rejected by admin';
    await withdrawal.save();

    await safeNotify({ userId: withdrawal.userId._id,
      type: 'withdrawal_rejected', title: '❌ Withdrawal Rejected',
      message: withdrawal.type === 'kes'
        ? `Your KES ${withdrawal.amount} withdrawal request was rejected. Your balance is unchanged. Reason: ${withdrawal.adminNotes}`
        : `Your points withdrawal request (${withdrawal.pointsRedeemed} pts) was rejected. Your points are unchanged. Reason: ${withdrawal.adminNotes}`,
      metadata: { withdrawalId: withdrawal._id, amount: withdrawal.amount, type: withdrawal.type }
    });

    // Email user — rejected
    const rejUser = withdrawal.userId;
    sendWithdrawalRejected(rejUser.email, rejUser.username, withdrawal.amount, withdrawal.type, withdrawal.adminNotes).catch(() => {});

    res.json({ message: 'Withdrawal rejected. User funds are unchanged.' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

module.exports = router;
