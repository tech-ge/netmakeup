const express = require('express');
const User = require('../models/Users');
const Commission = require('../models/Commission');
const Withdrawal = require('../models/Withdrawal');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// ==================== KES WALLET (PRIMARY) ====================
router.get('/primary', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);

    // Commission earnings (referrals)
    const commissions = await Commission.find({ toUserId: req.userId, type: 'referral_commission' })
      .sort({ createdAt: -1 }).limit(30);

    // KES withdrawal history
    const kesWithdrawals = await Withdrawal.find({ userId: req.userId, type: 'kes' })
      .sort({ requestedAt: -1 }).limit(20);

    res.json({
      wallet: { balance: user.primaryWallet.balance, currency: 'KES' },
      stats: { totalEarnings: user.stats.totalEarnings, totalReferrals: user.stats.totalReferrals },
      // Commission earnings (credits)
      recentCommissions: commissions.map(t => ({
        amount: t.amount,
        type: t.type,
        level: t.level,
        description: t.description,
        direction: 'credit',
        date: t.createdAt
      })),
      // KES withdrawal history (debits)
      kesWithdrawalHistory: kesWithdrawals.map(w => ({
        id: w._id,
        amount: w.amount,
        status: w.status,
        paymentMethod: w.paymentMethod,
        reference: w.transactionReference,
        direction: 'debit',
        requestedAt: w.requestedAt,
        processedAt: w.processedAt,
        adminNotes: w.adminNotes
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== POINTS WALLET ====================
router.get('/points', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);

    // All task earnings (points credits)
    const taskTypes = ['blog_earning', 'survey_earning', 'transcription_earning', 'writing_earning', 'dataentry_earning'];
    const taskEarnings = await Commission.find({ toUserId: req.userId, type: { $in: taskTypes } })
      .sort({ createdAt: -1 }).limit(50);

    // Points withdrawal history (points → KES via profit pool)
    const pointsWithdrawals = await Withdrawal.find({ userId: req.userId, type: 'points' })
      .sort({ requestedAt: -1 }).limit(20);

    const kesEquivalent = Math.floor(user.pointsWallet.points / 100) * 10;

    // Build points activity ledger: earnings (in) and withdrawals (out)
    const pointsHistory = [
      ...taskEarnings.map(t => ({
        date: t.createdAt,
        type: 'earn',
        taskType: t.type.replace('_earning', ''),
        description: t.description,
        points: t.amount,
        direction: 'in'
      })),
      ...pointsWithdrawals.map(w => ({
        date: w.requestedAt,
        type: 'withdrawal',
        taskType: 'withdrawal',
        description: `Points withdrawal: ${w.pointsRedeemed} pts → KES ${w.amount}`,
        points: w.pointsRedeemed,
        kesValue: w.amount,
        status: w.status,
        reference: w.transactionReference,
        direction: 'out'
      }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({
      points: user.pointsWallet.points,
      totalEarnedPoints: user.pointsWallet.totalEarned,
      kesEquivalent,
      canWithdraw: user.canWithdrawPoints(),
      withdrawalRequirements: {
        minPoints: 2000,
        minNewReferrals: 4,
        currentPoints: user.pointsWallet.points,
        newReferralsSinceLastWithdrawal: user.pointsWallet.referralsSinceLastWithdrawal || 0,
        lastWithdrawalAt: user.pointsWallet.lastWithdrawalAt
      },
      // Breakdown by task type
      breakdown: {
        blogs:         { count: taskEarnings.filter(t => t.type === 'blog_earning').length,         points: taskEarnings.filter(t => t.type === 'blog_earning').reduce((s,t) => s+t.amount, 0) },
        surveys:       { count: taskEarnings.filter(t => t.type === 'survey_earning').length,       points: taskEarnings.filter(t => t.type === 'survey_earning').reduce((s,t) => s+t.amount, 0) },
        transcription: { count: taskEarnings.filter(t => t.type === 'transcription_earning').length, points: taskEarnings.filter(t => t.type === 'transcription_earning').reduce((s,t) => s+t.amount, 0) },
        writing:       { count: taskEarnings.filter(t => t.type === 'writing_earning').length,       points: taskEarnings.filter(t => t.type === 'writing_earning').reduce((s,t) => s+t.amount, 0) },
        dataEntry:     { count: taskEarnings.filter(t => t.type === 'dataentry_earning').length,     points: taskEarnings.filter(t => t.type === 'dataentry_earning').reduce((s,t) => s+t.amount, 0) }
      },
      // Full chronological history: earnings + withdrawals
      pointsHistory,
      // Withdrawal history only (for dedicated history tab)
      withdrawalHistory: pointsWithdrawals.map(w => ({
        id: w._id,
        pointsRedeemed: w.pointsRedeemed,
        kesValue: w.amount,
        status: w.status,
        paymentMethod: w.paymentMethod,
        reference: w.transactionReference,
        requestedAt: w.requestedAt,
        processedAt: w.processedAt,
        adminNotes: w.adminNotes
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== FULL WALLET SUMMARY ====================
router.get('/summary', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);

    const [kesWithdrawals, pointsWithdrawals] = await Promise.all([
      Withdrawal.find({ userId: req.userId, type: 'kes', status: 'completed' }),
      Withdrawal.find({ userId: req.userId, type: 'points', status: 'completed' })
    ]);

    res.json({
      kes: {
        currentBalance: user.primaryWallet.balance,
        totalEarned: user.stats.totalEarnings,
        totalWithdrawn: kesWithdrawals.reduce((s, w) => s + w.amount, 0),
        withdrawalCount: kesWithdrawals.length
      },
      points: {
        currentPoints: user.pointsWallet.points,
        totalEarned: user.pointsWallet.totalEarned,
        totalPointsWithdrawn: pointsWithdrawals.reduce((s, w) => s + w.pointsRedeemed, 0),
        totalKesReceivedFromPoints: pointsWithdrawals.reduce((s, w) => s + w.amount, 0),
        withdrawalCount: pointsWithdrawals.length,
        currentKesEquivalent: Math.floor(user.pointsWallet.points / 100) * 10,
        canWithdraw: user.canWithdrawPoints(),
        newReferralsSinceLastWithdrawal: user.pointsWallet.referralsSinceLastWithdrawal || 0
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== GET WITHDRAWAL HISTORY (BOTH TYPES) ====================
router.get('/withdrawals', authMiddleware, async (req, res) => {
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
        requestedAt: w.requestedAt,
        processedAt: w.processedAt,
        transactionReference: w.transactionReference,
        adminNotes: w.adminNotes
      })),
      summary: {
        totalKesWithdrawn: withdrawals.filter(w => w.type === 'kes' && w.status === 'completed').reduce((s, w) => s + w.amount, 0),
        totalPointsWithdrawn: withdrawals.filter(w => w.type === 'points').reduce((s, w) => s + w.pointsRedeemed, 0),
        totalPointsKesValue: withdrawals.filter(w => w.type === 'points' && w.status === 'completed').reduce((s, w) => s + w.amount, 0),
        pending: withdrawals.filter(w => w.status === 'pending').length
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;