const express = require('express');
const Blog = require('../models/Blog');
const Survey = require('../models/Survey');
const User = require('../models/Users');
const Withdrawal = require('../models/Withdrawal');
const Commission = require('../models/Commission');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { PROFIT_PER_ACTIVATION, ACTIVATION_FEE } = require('../utils/commissionHelper');
const { sendCustomAdminEmail } = require('../utils/emailHelper');

const router = express.Router();

// ==================== DEPOSIT BALANCE ====================
router.post('/deposit-balance', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { userId, amount, reason = 'activation_deposit', reference } = req.body;
    if (!userId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'userId and valid amount required.' });
    }
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const prev = user.primaryWallet.balance;
    user.primaryWallet.balance += parseFloat(amount);
    await user.save();

    res.json({
      message: 'Balance deposited. User can now click Activate.',
      user: { id: user._id, username: user.username, email: user.email },
      transaction: { amount, previousBalance: prev, newBalance: user.primaryWallet.balance, reason, reference: reference || null, timestamp: new Date() }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== DASHBOARD STATS ====================
router.get('/dashboard/stats', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const [totalUsers, activeUsers, pendingUsers, suspendedUsers, notActivated, normalUsers,
      totalWithdrawalsPending, blogSubmissions, surveySubmissions] = await Promise.all([
      User.countDocuments({ isAdmin: false }),
      User.countDocuments({ status: 'active', isAdmin: false }),
      User.countDocuments({ status: 'pending', isAdmin: false }),
      User.countDocuments({ status: 'suspended', isAdmin: false }),
      User.countDocuments({ packageType: 'not_active', isAdmin: false }),
      User.countDocuments({ packageType: 'normal', isAdmin: false }),
      Withdrawal.countDocuments({ status: 'pending' }),
      Blog.countDocuments({ 'bids.bidStatus': 'submitted' }),
      Survey.countDocuments({ 'bids.bidStatus': 'submitted' })
    ]);

    const walletAgg = await User.aggregate([
      { $match: { isAdmin: false } },
      { $group: { _id: null, kesTotal: { $sum: '$primaryWallet.balance' }, ptsTotal: { $sum: '$pointsWallet.points' } } }
    ]);

    const totalRevenue = normalUsers * ACTIVATION_FEE;
    const totalProfit = normalUsers * PROFIT_PER_ACTIVATION;
    const paidPointsWithdrawals = await Withdrawal.aggregate([
      { $match: { type: 'points', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const pointsPayoutCost = paidPointsWithdrawals[0]?.total || 0;

    res.json({
      users: { total: totalUsers, active: activeUsers, pending: pendingUsers, suspended: suspendedUsers },
      packages: { notActivated, normal: normalUsers },
      pendingWithdrawals: totalWithdrawalsPending,
      pendingReviews: { blogs: blogSubmissions, surveys: surveySubmissions },
      totalKesInWallets: walletAgg[0]?.kesTotal || 0,
      totalPointsInSystem: walletAgg[0]?.ptsTotal || 0,
      profit: {
        totalRevenue,
        profitPool: totalProfit,
        pointsPayoutsCost: pointsPayoutCost,
        netProfitPool: totalProfit - pointsPayoutCost
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== P&L REPORT ====================
// Revenue: KES 250 per activation (profit portion of KES 700 fee)
// Costs: Points withdrawal payouts (from profit pool)
// Business Health: KES in user wallets vs system cash position
router.get('/profit-summary', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { period = 'all' } = req.query;

    let dateFilter = {};
    const now = new Date();
    if (period === 'week') {
      const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);
      dateFilter = { $gte: weekAgo };
    } else if (period === 'month') {
      const monthAgo = new Date(now); monthAgo.setMonth(monthAgo.getMonth() - 1);
      dateFilter = { $gte: monthAgo };
    }

    const userFilter = { packageType: 'normal', isAdmin: false };
    if (period !== 'all') userFilter.activatedAt = dateFilter;
    const activatedCount = await User.countDocuments(userFilter);

    // Revenue = activation fees (profit share only)
    const grossRevenue = activatedCount * ACTIVATION_FEE;
    const profitFromActivations = activatedCount * PROFIT_PER_ACTIVATION;
    const commissionsPaid = activatedCount * (ACTIVATION_FEE - PROFIT_PER_ACTIVATION); // 450 per user

    // Points withdrawal costs (paid from profit pool)
    const wFilter = { type: 'points', status: 'completed' };
    if (period !== 'all') wFilter.processedAt = dateFilter;
    const pointsPayouts = await Withdrawal.aggregate([
      { $match: wFilter },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);
    const pointsPayoutTotal = pointsPayouts[0]?.total || 0;
    const pointsPayoutCount = pointsPayouts[0]?.count || 0;

    // KES withdrawals (these come from user wallets, not profit — but track for business health)
    const kesWFilter = { type: 'kes', status: 'completed' };
    if (period !== 'all') kesWFilter.processedAt = dateFilter;
    const kesPayouts = await Withdrawal.aggregate([
      { $match: kesWFilter },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);
    const kesPayoutTotal = kesPayouts[0]?.total || 0;

    // Net profit = profit from activations - points payout costs
    const netProfit = profitFromActivations - pointsPayoutTotal;

    // Business health: total KES in user wallets vs total KES withdrawn
    const walletAgg = await User.aggregate([
      { $match: { isAdmin: false } },
      { $group: { _id: null, totalKes: { $sum: '$primaryWallet.balance' }, totalPts: { $sum: '$pointsWallet.points' } } }
    ]);
    const totalKesInWallets = walletAgg[0]?.totalKes || 0;
    const totalPtsInSystem = walletAgg[0]?.totalPts || 0;
    const totalPtsKesValue = Math.floor(totalPtsInSystem / 100) * 10; // pts outstanding value

    res.json({
      period,
      activations: {
        count: activatedCount,
        grossRevenue,
        commissionsPaid,
        profitContribution: profitFromActivations
      },
      profitPool: {
        total: profitFromActivations,
        pointsPayoutsCost: pointsPayoutTotal,
        pointsPayoutsCount: pointsPayoutCount,
        netProfit,
        netProfitMargin: profitFromActivations > 0
          ? ((netProfit / profitFromActivations) * 100).toFixed(1) + '%'
          : '0%'
      },
      businessHealth: {
        totalKesInUserWallets: totalKesInWallets,
        totalKesWithdrawnByUsers: kesPayoutTotal,
        totalPointsInSystem: totalPtsInSystem,
        totalPointsOutstandingKesValue: totalPtsKesValue,
        // This is what the business owes users (wallet balances not yet withdrawn)
        totalLiability: totalKesInWallets + totalPtsKesValue
      },
      kesWithdrawals: {
        completedTotal: kesPayoutTotal,
        count: kesPayouts[0]?.count || 0,
        note: 'KES withdrawals come from user wallets (referral commissions), not profit pool'
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== TRANSACTION LEDGER ====================
router.get('/transactions', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { period = 'all', limit = 50, type } = req.query;

    let dateFilter = {};
    const now = new Date();
    if (period === 'week') {
      const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);
      dateFilter = { createdAt: { $gte: weekAgo } };
    } else if (period === 'month') {
      const monthAgo = new Date(now); monthAgo.setMonth(monthAgo.getMonth() - 1);
      dateFilter = { createdAt: { $gte: monthAgo } };
    }

    // Withdrawals ledger
    const wQuery = { ...dateFilter };
    if (type === 'kes') wQuery.type = 'kes';
    else if (type === 'points') wQuery.type = 'points';

    const withdrawals = await Withdrawal.find(wQuery)
      .sort({ createdAt: -1 }).limit(parseInt(limit))
      .populate('userId', 'username email');

    const transactions = withdrawals.map(w => ({
      id: w._id,
      date: w.requestedAt,
      type: w.type === 'kes' ? 'KES Withdrawal' : 'Points Withdrawal',
      direction: 'out',
      paidFrom: w.type === 'kes' ? 'User Wallet' : 'Profit Pool',
      user: w.userId?.username || 'Unknown',
      email: w.userId?.email || '',
      amount: w.amount,
      pointsRedeemed: w.pointsRedeemed || 0,
      status: w.status,
      reference: w.transactionReference
    }));

    res.json({ period, transactions, total: transactions.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== GET ALL USERS ====================
router.get('/users/all', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { status, packageType, page = 1, limit = 50 } = req.query;
    const filter = { isAdmin: false };
    if (status && status !== 'all') filter.status = status;
    if (packageType && packageType !== 'all') filter.packageType = packageType;

    const skip = (page - 1) * limit;
    const [users, total] = await Promise.all([
      User.find(filter)
        .select('_id username email phone status packageType primaryWallet pointsWallet stats createdAt referrerId activeReferrals')
        .populate('referrerId', 'username email')
        .sort({ createdAt: -1 })
        .skip(skip).limit(parseInt(limit)),
      User.countDocuments(filter)
    ]);

    res.json({
      total, pages: Math.ceil(total / limit), currentPage: parseInt(page),
      users: users.map(u => ({
        id: u._id, username: u.username, email: u.email, phone: u.phone,
        status: u.status, packageType: u.packageType,
        walletBalance: u.primaryWallet.balance,
        pointsBalance: u.pointsWallet.points,
        activeReferrals: u.stats.activeDirectReferrals || 0,
        referredBy: u.referrerId ? { id: u.referrerId._id, username: u.referrerId.username } : null,
        joinedAt: u.createdAt
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== PENDING ACTIVATION ====================
router.get('/users/pending-activation', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const users = await User.find({ packageType: 'not_active', isAdmin: false })
      .select('_id username email phone createdAt primaryWallet referrerId')
      .populate('referrerId', 'username email phone')
      .sort({ createdAt: -1 });

    res.json({
      count: users.length,
      users: users.map(u => ({
        id: u._id, username: u.username, email: u.email, phone: u.phone,
        walletBalance: u.primaryWallet.balance,
        referredBy: u.referrerId ? {
          id: u.referrerId._id, username: u.referrerId.username,
          email: u.referrerId.email, phone: u.referrerId.phone
        } : null,
        createdAt: u.createdAt
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== SUSPEND / UNSUSPEND ====================
router.post('/users/:userId/suspend', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isAdmin) return res.status(400).json({ error: 'Cannot suspend admin.' });
    user.status = 'suspended';
    await user.save();
    res.json({ message: `${user.username} suspended.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/users/:userId/unsuspend', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.status = user.packageType === 'not_active' ? 'pending' : 'active';
    user.loginAttempts = 0;
    user.lockUntil = null;
    await user.save();
    res.json({ message: `${user.username} unsuspended.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== BLOG MANAGEMENT ====================
router.get('/blogs/all', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const blogs = await Blog.find().sort({ createdAt: -1 });
    res.json({
      blogs: blogs.map(b => ({
        id: b._id, title: b.title, description: b.description,
        category: b.category, reward: b.reward, status: b.status,
        maxWorkers: b.maxWorkers || 0,
        totalSubmissions: b.bids.length,
        pendingReview: b.bids.filter(bid => bid.bidStatus === 'submitted').length,
        approved: b.bids.filter(bid => bid.bidStatus === 'approved').length,
        slotsLeft: Math.max(0, (b.maxWorkers || 0) - b.bids.filter(bid => ['submitted','approved'].includes(bid.bidStatus)).length),
        deadline: b.deadline, createdAt: b.createdAt
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/blogs/:blogId/submissions', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.blogId).populate('bids.userId', 'username email');
    if (!blog) return res.status(404).json({ error: 'Blog not found' });
    res.json({
      blogTitle: blog.title,
      submissions: blog.bids.map(b => ({
        userId: b.userId._id, username: b.userId.username, email: b.userId.email,
        status: b.bidStatus, content: b.submissionContent,
        submittedAt: b.submittedAt, approvedAt: b.approvedAt, reviewNotes: b.reviewNotes
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== SURVEY MANAGEMENT ====================
router.get('/surveys/all', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const surveys = await Survey.find().sort({ createdAt: -1 });
    res.json({
      surveys: surveys.map(s => ({
        id: s._id, title: s.title, description: s.description,
        questionsCount: s.questions.length, reward: s.reward, status: s.status,
        maxWorkers: s.maxWorkers || 0,
        totalSubmissions: s.bids.length,
        pendingReview: s.bids.filter(b => b.bidStatus === 'submitted').length,
        approved: s.bids.filter(b => b.bidStatus === 'approved').length,
        slotsLeft: Math.max(0, (s.maxWorkers || 0) - s.bids.filter(b => ['submitted','approved'].includes(b.bidStatus)).length),
        deadline: s.deadline, createdAt: s.createdAt
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/surveys/:surveyId/submissions', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const survey = await Survey.findById(req.params.surveyId).populate('bids.userId', 'username email');
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    res.json({
      surveyTitle: survey.title,
      questions: survey.questions,
      submissions: survey.bids.map(b => ({
        userId: b.userId._id, username: b.userId.username, email: b.userId.email,
        status: b.bidStatus, responses: b.submissionContent,
        submittedAt: b.submittedAt, approvedAt: b.approvedAt, reviewNotes: b.reviewNotes
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/admin/users/:userId
router.delete('/users/:userId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.isAdmin) return res.status(400).json({ error: 'Cannot delete admin accounts.' });
    await User.findByIdAndDelete(req.params.userId);
    res.json({ message: `✅ User deleted.` });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── Blog admin routes (called as /api/admin/blogs/*) ────────────────────────

router.post('/blogs/create', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { title, description, content, category, maxBidders, reward } = req.body;
    if (!title || !description) return res.status(400).json({ error: 'Title and description required.' });
    const blog = await Blog.create({
      title, description, content: content || '', category: category || 'general',
      maxBidders: maxBidders || 50, reward: reward || 100, isOpen: true, postedAt: new Date()
    });
    res.json({ message: 'Blog created.', blog });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.put('/blogs/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) return res.status(404).json({ error: 'Blog not found' });
    const { title, description, content, category, maxBidders, reward } = req.body;
    if (title)       blog.title       = title;
    if (description) blog.description = description;
    if (content)     blog.content     = content;
    if (category)    blog.category    = category;
    if (maxBidders)  blog.maxBidders  = maxBidders;
    if (reward)      blog.reward      = reward;
    await blog.save();
    res.json({ message: 'Blog updated.', blog });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/blogs/:id/close', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) return res.status(404).json({ error: 'Blog not found' });
    blog.isOpen = false;
    await blog.save();
    res.json({ message: 'Blog closed.' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.delete('/blogs/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) return res.status(404).json({ error: 'Blog not found' });
    await Blog.deleteOne({ _id: blog._id });
    res.json({ message: 'Blog deleted.' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/blogs/:blogId/approve/:userId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.blogId);
    if (!blog) return res.status(404).json({ error: 'Blog not found' });
    const bid = blog.bids.find(b => b.userId.toString() === req.params.userId);
    if (!bid) return res.status(404).json({ error: 'Submission not found' });
    if (bid.bidStatus === 'approved') return res.status(400).json({ error: 'Already approved' });
    bid.bidStatus = 'approved';
    bid.approvedAt = new Date();
    await blog.save();
    await User.findByIdAndUpdate(req.params.userId, { $inc: { 'pointsWallet.points': blog.reward } });
    res.json({ message: 'Blog submission approved.' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/blogs/:blogId/reject/:userId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.blogId);
    if (!blog) return res.status(404).json({ error: 'Blog not found' });
    const bid = blog.bids.find(b => b.userId.toString() === req.params.userId);
    if (!bid) return res.status(404).json({ error: 'Submission not found' });
    bid.bidStatus = 'rejected';
    bid.reviewNotes = req.body.reviewNotes || 'Rejected';
    bid.reviewedAt = new Date();
    await blog.save();
    res.json({ message: 'Blog submission rejected.' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ─── Survey admin routes (called as /api/admin/surveys/*) ─────────────────────

router.post('/surveys/create', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { title, description, questions, maxResponses, reward } = req.body;
    if (!title || !questions || !questions.length) return res.status(400).json({ error: 'Title and questions required.' });
    const survey = await Survey.create({
      title, description: description || '', questions,
      maxResponses: maxResponses || 100, reward: reward || 100, isOpen: true, postedAt: new Date()
    });
    res.json({ message: 'Survey created.', survey });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.put('/surveys/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const survey = await Survey.findById(req.params.id);
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    const { title, description, maxResponses, reward } = req.body;
    if (title)        survey.title        = title;
    if (description)  survey.description  = description;
    if (maxResponses) survey.maxResponses = maxResponses;
    if (reward)       survey.reward       = reward;
    await survey.save();
    res.json({ message: 'Survey updated.', survey });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/surveys/:id/close', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const survey = await Survey.findById(req.params.id);
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    survey.isOpen = false;
    await survey.save();
    res.json({ message: 'Survey closed.' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.delete('/surveys/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const survey = await Survey.findById(req.params.id);
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    await Survey.deleteOne({ _id: survey._id });
    res.json({ message: 'Survey deleted.' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/surveys/:surveyId/approve/:userId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const survey = await Survey.findById(req.params.surveyId);
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    const bid = survey.bids.find(b => b.userId.toString() === req.params.userId);
    if (!bid) return res.status(404).json({ error: 'Submission not found' });
    if (bid.bidStatus === 'approved') return res.status(400).json({ error: 'Already approved' });
    bid.bidStatus = 'approved';
    bid.approvedAt = new Date();
    await survey.save();
    await User.findByIdAndUpdate(req.params.userId, { $inc: { 'pointsWallet.points': survey.reward } });
    res.json({ message: 'Survey submission approved.' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/surveys/:surveyId/reject/:userId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const survey = await Survey.findById(req.params.surveyId);
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    const bid = survey.bids.find(b => b.userId.toString() === req.params.userId);
    if (!bid) return res.status(404).json({ error: 'Submission not found' });
    bid.bidStatus = 'rejected';
    bid.reviewNotes = req.body.reviewNotes || 'Rejected';
    bid.reviewedAt = new Date();
    await survey.save();
    res.json({ message: 'Survey submission rejected.' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ==================== EMAIL MANAGEMENT ====================
// Send custom email to a single user
router.post('/send-email', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { userId, subject, message } = req.body;
    if (!userId || !subject || !message)
      return res.status(400).json({ error: 'userId, subject, and message required.' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    // Send email (non-blocking)
    sendCustomAdminEmail(user.email, user.username, subject, message).catch(err => {
      console.error('Admin email failed:', err.message);
    });

    res.json({
      message: 'Email queued for delivery.',
      sent_to: user.email,
      user: { id: user._id, username: user.username, email: user.email }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send bulk email to multiple users (filtered)
// Query params: status=active|pending|suspended, packageType=normal|not_active
router.post('/send-bulk-email', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { subject, message, status, packageType } = req.body;
    if (!subject || !message)
      return res.status(400).json({ error: 'subject and message required.' });

    // Build filter
    const filter = { isAdmin: false };
    if (status && ['active', 'pending', 'suspended'].includes(status)) filter.status = status;
    if (packageType && ['normal', 'not_active'].includes(packageType)) filter.packageType = packageType;

    const users = await User.find(filter);
    if (users.length === 0) return res.status(400).json({ error: 'No users match the filter.' });

    // Send emails non-blocking (fire and forget)
    users.forEach(user => {
      sendCustomAdminEmail(user.email, user.username, subject, message).catch(() => {});
    });

    res.json({
      message: `Email queued for delivery to ${users.length} users.`,
      recipients_count: users.length,
      filter: { status: status || 'all', packageType: packageType || 'all' }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
