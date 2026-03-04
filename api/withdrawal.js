const express = require('express');
const Withdrawal = require('../models/Withdrawal');
const User = require('../models/Users');
const Commission = require('../models/Commission');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// EAT = UTC+3
function getEATDay() {
  const now = new Date();
  const eatTime = new Date(now.getTime() + 3 * 60 * 60000);
  return eatTime.getUTCDay(); // 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat
}

function isTuesday()  { return getEATDay() === 2; } // Points withdrawal day
function isThursday() { return getEATDay() === 4; } // KES wallet withdrawal day

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// ==================== POINTS WITHDRAWAL (TUESDAYS) ====================
// Converts user points → KES. Paid from BUSINESS PROFIT POOL (not user KES wallet).
// Points are deducted from user's pointsWallet. Business pays out KES from profit.
router.post('/points', authMiddleware, async (req, res) => {
  try {
    const { paymentMethod, paymentDetails } = req.body;
    const user = await User.findById(req.userId);

    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.packageType === 'not_active' || user.status !== 'active') {
      return res.status(400).json({ error: 'Activate your package before withdrawing points.' });
    }

    if (!isTuesday()) {
      return res.status(400).json({
        error: 'Points withdrawals are only processed on Tuesdays (EAT).',
        today: DAYS[getEATDay()],
        nextWithdrawalDay: 'Tuesday'
      });
    }

    // Eligibility: min 2000 pts + 4 new referrals since last withdrawal
    if (user.pointsWallet.points < 2000) {
      return res.status(400).json({
        error: `You need at least 2,000 points to withdraw. You have: ${user.pointsWallet.points}`,
        required: 2000,
        current: user.pointsWallet.points
      });
    }

    const newReferrals = user.pointsWallet.referralsSinceLastWithdrawal || 0;
    if (newReferrals < 4) {
      return res.status(400).json({
        error: `You need 4 new referrals since your last points withdrawal. You have: ${newReferrals}`,
        required: 4,
        current: newReferrals
      });
    }

    // One per Tuesday
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay   = new Date(); endOfDay.setHours(23, 59, 59, 999);
    const existing = await Withdrawal.findOne({
      userId: user._id, type: 'points',
      requestedAt: { $gte: startOfDay, $lte: endOfDay }
    });
    if (existing) {
      return res.status(400).json({
        error: 'You have already submitted a points withdrawal request today.',
        existing: { amount: existing.amount, pointsRedeemed: existing.pointsRedeemed, status: existing.status }
      });
    }

    if (!paymentMethod || !['mpesa', 'bank'].includes(paymentMethod)) {
      return res.status(400).json({ error: 'Valid payment method required (mpesa or bank).' });
    }
    if (paymentMethod === 'mpesa' && !paymentDetails?.mpesaPhone) {
      return res.status(400).json({ error: 'M-Pesa phone number required.' });
    }
    if (paymentMethod === 'bank' && (!paymentDetails?.accountNumber || !paymentDetails?.accountName)) {
      return res.status(400).json({ error: 'Bank account details required.' });
    }

    // Calculate KES value: 100 pts = KES 10
    const pointsToRedeem = user.pointsWallet.points;
    const kesValue       = Math.floor(pointsToRedeem / 100) * 10;
    const remainingPoints = pointsToRedeem % 100;

    // Atomically deduct points — prevents race condition
    const updatedUser = await User.findOneAndUpdate(
      { _id: req.userId, 'pointsWallet.points': { $gte: pointsToRedeem } },
      {
        $set: {
          'pointsWallet.points': remainingPoints,
          'pointsWallet.referralsSinceLastWithdrawal': 0,
          'pointsWallet.lastWithdrawalAt': new Date()
        }
      },
      { new: true }
    );
    if (!updatedUser) {
      return res.status(400).json({ error: 'Points balance changed. Please refresh and try again.' });
    }

    const withdrawal = new Withdrawal({
      userId: updatedUser._id,
      type: 'points',
      amount: kesValue,
      pointsRedeemed: pointsToRedeem - remainingPoints,
      paymentMethod,
      paymentDetails,
      status: 'pending',
      requestedAt: new Date()
    });
    await withdrawal.save();

    // Log as profit pool expense
    await Commission.create({
      fromUserId: updatedUser._id,
      toUserId:   updatedUser._id,
      level: 1,
      amount: kesValue,
      type: 'points_withdrawal_payout',
      status: 'pending',
      description: `Points withdrawal: ${pointsToRedeem - remainingPoints} pts → KES ${kesValue} (from profit pool)`,
      metadata: { withdrawalId: withdrawal._id, pointsRedeemed: pointsToRedeem - remainingPoints }
    });

    console.log(`🎯 POINTS WITHDRAWAL: ${pointsToRedeem - remainingPoints} pts → KES ${kesValue} for ${updatedUser.username} | ${withdrawal.transactionReference}`);

    res.status(201).json({
      message: `✅ Points withdrawal submitted. KES ${kesValue} will be sent to your ${paymentMethod} (Tuesday processing).`,
      withdrawal: {
        id: withdrawal._id,
        type: 'points',
        pointsRedeemed: pointsToRedeem - remainingPoints,
        kesValue,
        status: withdrawal.status,
        transactionReference: withdrawal.transactionReference,
        requestedAt: withdrawal.requestedAt
      },
      remainingPoints: updatedUser.pointsWallet.points
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== KES WALLET WITHDRAWAL (THURSDAYS) ====================
// Paid from user's primaryWallet (referral commissions earned)
router.post('/kes', authMiddleware, async (req, res) => {
  try {
    const { amount, paymentMethod, paymentDetails } = req.body;
    const user = await User.findById(req.userId);

    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.packageType === 'not_active' || user.status !== 'active') {
      return res.status(400).json({ error: 'Activate your package before withdrawing.' });
    }

    if (!isThursday()) {
      return res.status(400).json({
        error: 'KES wallet withdrawals are only processed on Thursdays (EAT).',
        today: DAYS[getEATDay()],
        nextWithdrawalDay: 'Thursday'
      });
    }

    const withdrawAmount = parseFloat(amount);
    if (!withdrawAmount || withdrawAmount < 300) {
      return res.status(400).json({ error: 'Minimum KES withdrawal is KES 300.' });
    }

    // One per Thursday
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay   = new Date(); endOfDay.setHours(23, 59, 59, 999);
    const existing = await Withdrawal.findOne({
      userId: user._id, type: 'kes',
      requestedAt: { $gte: startOfDay, $lte: endOfDay }
    });
    if (existing) {
      return res.status(400).json({
        error: 'You have already submitted a KES withdrawal request today.',
        existing: { amount: existing.amount, status: existing.status }
      });
    }

    if (!paymentMethod || !['mpesa', 'bank'].includes(paymentMethod)) {
      return res.status(400).json({ error: 'Valid payment method required (mpesa or bank).' });
    }
    if (paymentMethod === 'mpesa' && !paymentDetails?.mpesaPhone) {
      return res.status(400).json({ error: 'M-Pesa phone number required.' });
    }
    if (paymentMethod === 'bank' && (!paymentDetails?.accountNumber || !paymentDetails?.accountName)) {
      return res.status(400).json({ error: 'Bank account details required.' });
    }

    // Atomic deduction — prevents race condition
    const updatedUser = await User.findOneAndUpdate(
      { _id: req.userId, 'primaryWallet.balance': { $gte: withdrawAmount }, 'primaryWallet.locked': false },
      { $inc: { 'primaryWallet.balance': -withdrawAmount } },
      { new: true }
    );
    if (!updatedUser) {
      return res.status(400).json({
        error: 'Insufficient KES balance or wallet is locked.',
        available: user.primaryWallet.balance,
        required: withdrawAmount
      });
    }

    const withdrawal = new Withdrawal({
      userId: updatedUser._id,
      type: 'kes',
      amount: withdrawAmount,
      paymentMethod,
      paymentDetails,
      status: 'pending',
      requestedAt: new Date()
    });
    await withdrawal.save();

    console.log(`💸 KES WITHDRAWAL: KES ${withdrawAmount} from ${updatedUser.username} | ${withdrawal.transactionReference}`);

    res.status(201).json({
      message: '✅ KES withdrawal request submitted. Admin will process it today (Thursday).',
      withdrawal: {
        id: withdrawal._id,
        type: 'kes',
        amount: withdrawal.amount,
        status: withdrawal.status,
        transactionReference: withdrawal.transactionReference,
        requestedAt: withdrawal.requestedAt
      },
      newBalance: updatedUser.primaryWallet.balance
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== USER: OWN WITHDRAWAL HISTORY ====================
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find({ userId: req.userId }).sort({ requestedAt: -1 });
    res.json({
      withdrawals: withdrawals.map(w => ({
        id: w._id,
        type: w.type,
        amount: w.amount,
        pointsRedeemed: w.pointsRedeemed || 0,
        status: w.status,
        paymentMethod: w.paymentMethod,
        paymentDetails: w.paymentDetails,
        requestedAt: w.requestedAt,
        processedAt: w.processedAt,
        transactionReference: w.transactionReference,
        adminNotes: w.adminNotes
      })),
      summary: {
        totalKesWithdrawn:        withdrawals.filter(w => w.type === 'kes'    && w.status === 'completed').reduce((s, w) => s + w.amount, 0),
        totalPointsWithdrawn:     withdrawals.filter(w => w.type === 'points').reduce((s, w) => s + w.pointsRedeemed, 0),
        totalPointsKesReceived:   withdrawals.filter(w => w.type === 'points' && w.status === 'completed').reduce((s, w) => s + w.amount, 0),
        pending: withdrawals.filter(w => w.status === 'pending').length
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ADMIN: PENDING ====================
router.get('/admin/pending', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { type } = req.query;
    const query = { status: 'pending' };
    if (type && ['kes','points'].includes(type)) query.type = type;

    const withdrawals = await Withdrawal.find(query)
      .sort({ requestedAt: 1 })
      .populate('userId', 'username email phone');

    res.json({
      withdrawals: withdrawals.map(w => ({
        id: w._id, type: w.type,
        userId: w.userId._id, username: w.userId.username,
        email: w.userId.email, phone: w.userId.phone,
        amount: w.amount, pointsRedeemed: w.pointsRedeemed || 0,
        paymentMethod: w.paymentMethod, paymentDetails: w.paymentDetails,
        requestedAt: w.requestedAt, transactionReference: w.transactionReference
      })),
      totalPending:         withdrawals.length,
      totalKesAmount:       withdrawals.filter(w => w.type === 'kes').reduce((s, w) => s + w.amount, 0),
      totalPointsKesAmount: withdrawals.filter(w => w.type === 'points').reduce((s, w) => s + w.amount, 0)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ADMIN: ALL ====================
router.get('/admin/all', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { status, type } = req.query;
    const query = {};
    if (status) query.status = status;
    if (type && ['kes','points'].includes(type)) query.type = type;

    const withdrawals = await Withdrawal.find(query)
      .sort({ requestedAt: -1 })
      .populate('userId', 'username email phone');

    res.json({
      withdrawals: withdrawals.map(w => ({
        id: w._id, type: w.type,
        userId: w.userId._id, username: w.userId.username,
        email: w.userId.email, phone: w.userId.phone,
        amount: w.amount, pointsRedeemed: w.pointsRedeemed || 0,
        status: w.status, paymentMethod: w.paymentMethod,
        paymentDetails: w.paymentDetails, requestedAt: w.requestedAt,
        processedAt: w.processedAt, adminNotes: w.adminNotes,
        transactionReference: w.transactionReference
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ADMIN: COMPLETE ====================
router.post('/admin/:id/complete', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { adminNotes } = req.body;
    const withdrawal = await Withdrawal.findById(req.params.id);
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ error: `Cannot complete a ${withdrawal.status} withdrawal.` });
    }

    withdrawal.status      = 'completed';
    withdrawal.processedAt = new Date();
    withdrawal.completedAt = new Date();
    withdrawal.adminNotes  = adminNotes || 'Processed by admin';
    await withdrawal.save();

    if (withdrawal.type === 'points') {
      await Commission.updateOne(
        { 'metadata.withdrawalId': withdrawal._id, type: 'points_withdrawal_payout' },
        { $set: { status: 'completed' } }
      );
    }

    res.json({
      message: `${withdrawal.type === 'points' ? 'Points' : 'KES'} withdrawal completed.`,
      withdrawal: { id: withdrawal._id, status: withdrawal.status, type: withdrawal.type }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ADMIN: REJECT ====================
router.post('/admin/:id/reject', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { adminNotes } = req.body;
    const withdrawal = await Withdrawal.findById(req.params.id).populate('userId');
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ error: `Cannot reject a ${withdrawal.status} withdrawal.` });
    }

    if (withdrawal.type === 'kes') {
      // Refund KES back to user wallet
      await User.findByIdAndUpdate(withdrawal.userId._id, {
        $inc: { 'primaryWallet.balance': withdrawal.amount }
      });
    } else {
      // Restore points + referral counter
      await User.findByIdAndUpdate(withdrawal.userId._id, {
        $inc: {
          'pointsWallet.points': withdrawal.pointsRedeemed,
          'pointsWallet.referralsSinceLastWithdrawal': 4
        },
        $set: { 'pointsWallet.lastWithdrawalAt': null }
      });
      await Commission.updateOne(
        { 'metadata.withdrawalId': withdrawal._id },
        { $set: { status: 'failed' } }
      );
    }

    withdrawal.status      = 'rejected';
    withdrawal.processedAt = new Date();
    withdrawal.adminNotes  = adminNotes || 'Rejected by admin';
    await withdrawal.save();

    res.json({
      message: `Withdrawal rejected. ${withdrawal.type === 'kes' ? 'KES refunded to user wallet.' : 'Points restored to user.'}`,
      refundedAmount:  withdrawal.type === 'kes'    ? withdrawal.amount         : null,
      restoredPoints:  withdrawal.type === 'points' ? withdrawal.pointsRedeemed : null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;