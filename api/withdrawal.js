const express    = require('express');
const Withdrawal = require('../models/Withdrawal');
const User       = require('../models/Users');
const Commission = require('../models/Commission');
const Notification = require('../models/Notification');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ─── EAT (UTC+3) helpers ─────────────────────────────────────────────────────
function nowEAT() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000);
}
function getEATDay() {
  return nowEAT().getUTCDay(); // 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat
}
// Start/end of current EAT calendar day expressed as UTC Date objects
function eatDayBounds() {
  const eat      = nowEAT();
  const eatMidnight = new Date(eat);
  eatMidnight.setUTCHours(0, 0, 0, 0);
  const startUTC = new Date(eatMidnight.getTime() - 3 * 60 * 60 * 1000);
  const endUTC   = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { startUTC, endUTC };
}

const isTuesday  = () => getEATDay() === 2;
const isThursday = () => getEATDay() === 4;
const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// ============================================================
// POINTS WITHDRAWAL (Tuesdays EAT)
// Points → KES, paid from business profit pool (NOT user KES wallet)
// Requirement: ≥ 2000 pts AND ≥ 4 new referrals since last withdrawal
// Rate: 100 pts = KES 10  (leftover pts < 100 stay in wallet)
// ============================================================
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
        error:               'Points withdrawals are only processed on Tuesdays (EAT).',
        today:               DAYS[getEATDay()],
        nextWithdrawalDay:   'Tuesday'
      });
    }
    if (user.pointsWallet.points < 2000) {
      return res.status(400).json({
        error:    `You need at least 2,000 points to withdraw. You have: ${user.pointsWallet.points}`,
        required: 2000,
        current:  user.pointsWallet.points
      });
    }
    const newReferrals = user.pointsWallet.referralsSinceLastWithdrawal || 0;
    if (newReferrals < 4) {
      return res.status(400).json({
        error:    `You need 4 new referrals since your last points withdrawal. You have: ${newReferrals}`,
        required: 4,
        current:  newReferrals
      });
    }

    // One request per EAT Tuesday (using EAT-correct day bounds)
    const { startUTC, endUTC } = eatDayBounds();
    const existing = await Withdrawal.findOne({
      userId: user._id, type: 'points',
      requestedAt: { $gte: startUTC, $lte: endUTC }
    });
    if (existing) {
      return res.status(400).json({
        error:    'You have already submitted a points withdrawal request today.',
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

    // Calculate KES value: 100 pts = KES 10; remainder stays in wallet
    const totalPoints    = user.pointsWallet.points;
    const redeemable     = Math.floor(totalPoints / 100) * 100; // round down to nearest 100
    const kesValue       = (redeemable / 100) * 10;
    const remainingPoints = totalPoints - redeemable;

    if (redeemable === 0) {
      return res.status(400).json({ error: 'Not enough points for a full 100-point redemption unit.' });
    }

    // Atomic deduction — prevents double-spend race condition
    const updatedUser = await User.findOneAndUpdate(
      { _id: req.userId, 'pointsWallet.points': { $gte: redeemable } },
      {
        $set: {
          'pointsWallet.points':                        remainingPoints,
          'pointsWallet.referralsSinceLastWithdrawal':  0,
          'pointsWallet.lastWithdrawalAt':              new Date()
        }
      },
      { new: true }
    );
    if (!updatedUser) {
      return res.status(400).json({ error: 'Points balance changed. Please refresh and try again.' });
    }

    const withdrawal = await Withdrawal.create({
      userId:         updatedUser._id,
      type:           'points',
      amount:         kesValue,
      pointsRedeemed: redeemable,
      paymentMethod,
      paymentDetails,
      status:         'pending',
      requestedAt:    new Date()
    });

    // Log as profit pool expense (pending until admin completes)
    await Commission.create({
      fromUserId:  updatedUser._id,
      toUserId:    updatedUser._id,
      level:       1,
      amount:      kesValue,
      type:        'points_withdrawal_payout',
      status:      'pending',
      description: `Points withdrawal: ${redeemable} pts → KES ${kesValue} (profit pool)`,
      metadata:    { withdrawalId: withdrawal._id, pointsRedeemed: redeemable }
    });

    console.log(`🎯 POINTS WITHDRAWAL: ${redeemable} pts → KES ${kesValue} for ${updatedUser.username} | ${withdrawal.transactionReference}`);

    res.status(201).json({
      message: `✅ Points withdrawal submitted. KES ${kesValue} will be sent to your ${paymentMethod} on Tuesday.`,
      withdrawal: {
        id:                   withdrawal._id,
        type:                 'points',
        pointsRedeemed:       redeemable,
        kesValue,
        status:               withdrawal.status,
        transactionReference: withdrawal.transactionReference,
        requestedAt:          withdrawal.requestedAt
      },
      remainingPoints: updatedUser.pointsWallet.points
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// KES WALLET WITHDRAWAL (Thursdays EAT)
// Paid directly from user's primaryWallet (referral commissions)
// Minimum: KES 300
// ============================================================
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
        error:             'KES wallet withdrawals are only processed on Thursdays (EAT).',
        today:             DAYS[getEATDay()],
        nextWithdrawalDay: 'Thursday'
      });
    }

    const withdrawAmount = parseFloat(amount);
    if (!withdrawAmount || withdrawAmount < 300) {
      return res.status(400).json({ error: 'Minimum KES withdrawal is KES 300.' });
    }
    if (withdrawAmount > user.primaryWallet.balance) {
      return res.status(400).json({
        error:     'Insufficient KES balance.',
        available: user.primaryWallet.balance,
        requested: withdrawAmount
      });
    }

    // One request per EAT Thursday
    const { startUTC, endUTC } = eatDayBounds();
    const existing = await Withdrawal.findOne({
      userId: user._id, type: 'kes',
      requestedAt: { $gte: startUTC, $lte: endUTC }
    });
    if (existing) {
      return res.status(400).json({
        error:    'You have already submitted a KES withdrawal request today.',
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

    // Atomic deduction — prevents double-spend race condition
    const updatedUser = await User.findOneAndUpdate(
      {
        _id: req.userId,
        'primaryWallet.balance': { $gte: withdrawAmount },
        'primaryWallet.locked':  false
      },
      { $inc: { 'primaryWallet.balance': -withdrawAmount } },
      { new: true }
    );
    if (!updatedUser) {
      return res.status(400).json({
        error:     'Insufficient KES balance or wallet is locked.',
        available: user.primaryWallet.balance,
        required:  withdrawAmount
      });
    }

    const withdrawal = await Withdrawal.create({
      userId:         updatedUser._id,
      type:           'kes',
      amount:         withdrawAmount,
      paymentMethod,
      paymentDetails,
      status:         'pending',
      requestedAt:    new Date()
    });

    console.log(`💸 KES WITHDRAWAL: KES ${withdrawAmount} from ${updatedUser.username} | ${withdrawal.transactionReference}`);

    res.status(201).json({
      message: '✅ KES withdrawal submitted. Admin will process it today (Thursday).',
      withdrawal: {
        id:                   withdrawal._id,
        type:                 'kes',
        amount:               withdrawal.amount,
        status:               withdrawal.status,
        transactionReference: withdrawal.transactionReference,
        requestedAt:          withdrawal.requestedAt
      },
      newBalance: updatedUser.primaryWallet.balance
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// USER — own withdrawal history
// ============================================================
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find({ userId: req.userId }).sort({ requestedAt: -1 });
    res.json({
      withdrawals: withdrawals.map(w => ({
        id:                   w._id,
        type:                 w.type,
        amount:               w.amount,
        pointsRedeemed:       w.pointsRedeemed || 0,
        status:               w.status,
        paymentMethod:        w.paymentMethod,
        paymentDetails:       w.paymentDetails,
        requestedAt:          w.requestedAt,
        processedAt:          w.processedAt,
        transactionReference: w.transactionReference,
        adminNotes:           w.adminNotes
      })),
      summary: {
        totalKesWithdrawn:      withdrawals.filter(w => w.type === 'kes'    && w.status === 'completed').reduce((s, w) => s + w.amount, 0),
        totalPointsWithdrawn:   withdrawals.filter(w => w.type === 'points').reduce((s, w) => s + (w.pointsRedeemed || 0), 0),
        totalPointsKesReceived: withdrawals.filter(w => w.type === 'points' && w.status === 'completed').reduce((s, w) => s + w.amount, 0),
        pending:                withdrawals.filter(w => w.status === 'pending').length
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ADMIN — pending withdrawals
// ============================================================
router.get('/admin/pending', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { type } = req.query;
    const query = { status: 'pending' };
    if (type && ['kes', 'points'].includes(type)) query.type = type;

    const withdrawals = await Withdrawal.find(query)
      .sort({ requestedAt: 1 })
      .populate('userId', 'username email phone');

    res.json({
      withdrawals: withdrawals.map(w => ({
        id:                   w._id,
        type:                 w.type,
        userId:               w.userId._id,
        username:             w.userId.username,
        email:                w.userId.email,
        phone:                w.userId.phone,
        amount:               w.amount,
        pointsRedeemed:       w.pointsRedeemed || 0,
        paymentMethod:        w.paymentMethod,
        paymentDetails:       w.paymentDetails,
        requestedAt:          w.requestedAt,
        transactionReference: w.transactionReference
      })),
      totalPending:         withdrawals.length,
      totalKesAmount:       withdrawals.filter(w => w.type === 'kes').reduce((s, w) => s + w.amount, 0),
      totalPointsKesAmount: withdrawals.filter(w => w.type === 'points').reduce((s, w) => s + w.amount, 0)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ADMIN — all withdrawals
// ============================================================
router.get('/admin/all', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { status, type } = req.query;
    const query = {};
    if (status) query.status = status;
    if (type && ['kes', 'points'].includes(type)) query.type = type;

    const withdrawals = await Withdrawal.find(query)
      .sort({ requestedAt: -1 })
      .populate('userId', 'username email phone');

    res.json({
      withdrawals: withdrawals.map(w => ({
        id:                   w._id,
        type:                 w.type,
        userId:               w.userId._id,
        username:             w.userId.username,
        email:                w.userId.email,
        phone:                w.userId.phone,
        amount:               w.amount,
        pointsRedeemed:       w.pointsRedeemed || 0,
        status:               w.status,
        paymentMethod:        w.paymentMethod,
        paymentDetails:       w.paymentDetails,
        requestedAt:          w.requestedAt,
        processedAt:          w.processedAt,
        adminNotes:           w.adminNotes,
        transactionReference: w.transactionReference
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ADMIN — complete (mark as paid)
// ============================================================
router.post('/admin/:id/complete', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { adminNotes } = req.body;
    const withdrawal = await Withdrawal.findById(req.params.id).populate('userId', 'username email');
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ error: `Cannot complete a ${withdrawal.status} withdrawal.` });
    }

    withdrawal.status      = 'completed';
    withdrawal.processedAt = new Date();
    withdrawal.completedAt = new Date();
    withdrawal.adminNotes  = adminNotes || 'Processed by admin';
    await withdrawal.save();

    // Mark the profit pool commission record as completed
    if (withdrawal.type === 'points') {
      await Commission.updateOne(
        { 'metadata.withdrawalId': withdrawal._id, type: 'points_withdrawal_payout' },
        { $set: { status: 'completed' } }
      );
    }

    // Notify user
    await Notification.create({
      userId:  withdrawal.userId._id,
      type:    'withdrawal_paid',
      title:   '💸 Withdrawal Processed!',
      message: withdrawal.type === 'points'
        ? `Your points withdrawal of KES ${withdrawal.amount} has been sent to your ${withdrawal.paymentMethod}.`
        : `Your KES ${withdrawal.amount} withdrawal has been sent to your ${withdrawal.paymentMethod}.`,
      metadata: { withdrawalId: withdrawal._id, amount: withdrawal.amount, type: withdrawal.type }
    });

    res.json({
      message: `${withdrawal.type === 'points' ? 'Points' : 'KES'} withdrawal completed.`,
      withdrawal: { id: withdrawal._id, status: withdrawal.status, type: withdrawal.type }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ADMIN — reject (refund user correctly)
// ============================================================
router.post('/admin/:id/reject', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { adminNotes } = req.body;
    const withdrawal = await Withdrawal.findById(req.params.id).populate('userId');
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ error: `Cannot reject a ${withdrawal.status} withdrawal.` });
    }

    const userId = withdrawal.userId._id;

    if (withdrawal.type === 'kes') {
      // Refund KES back to primary wallet
      await User.findByIdAndUpdate(userId, {
        $inc: { 'primaryWallet.balance': withdrawal.amount }
      });
    } else {
      // Restore the exact points that were redeemed (not a hardcoded 4)
      // Also restore referral counter to what it was before (we set it to 0 on request)
      // We restore 4 because that was the minimum required; actual count lost was unknown,
      // so we conservatively restore 4 to let them re-qualify.
      // More accurately: store referralsSinceLastWithdrawal snapshot at withdrawal time.
      // For now we restore pointsRedeemed exactly and set referrals back to 4 (minimum threshold)
      await User.findByIdAndUpdate(userId, {
        $inc: { 'pointsWallet.points': withdrawal.pointsRedeemed },
        $set: {
          'pointsWallet.referralsSinceLastWithdrawal': 4, // restore minimum qualifying amount
          'pointsWallet.lastWithdrawalAt': null
        }
      });
      await Commission.updateOne(
        { 'metadata.withdrawalId': withdrawal._id, type: 'points_withdrawal_payout' },
        { $set: { status: 'failed' } }
      );
    }

    withdrawal.status      = 'rejected';
    withdrawal.processedAt = new Date();
    withdrawal.adminNotes  = adminNotes || 'Rejected by admin';
    await withdrawal.save();

    // Notify user
    await Notification.create({
      userId,
      type:    'withdrawal_rejected',
      title:   '❌ Withdrawal Rejected',
      message: withdrawal.type === 'kes'
        ? `Your KES ${withdrawal.amount} withdrawal was rejected. KES ${withdrawal.amount} has been refunded to your wallet. Reason: ${withdrawal.adminNotes}`
        : `Your points withdrawal was rejected. ${withdrawal.pointsRedeemed} points have been restored to your account. Reason: ${withdrawal.adminNotes}`,
      metadata: { withdrawalId: withdrawal._id, amount: withdrawal.amount, type: withdrawal.type }
    });

    res.json({
      message:        `Withdrawal rejected. ${withdrawal.type === 'kes' ? 'KES refunded to user wallet.' : 'Points restored to user.'}`,
      refundedAmount: withdrawal.type === 'kes'    ? withdrawal.amount         : null,
      restoredPoints: withdrawal.type === 'points' ? withdrawal.pointsRedeemed : null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
