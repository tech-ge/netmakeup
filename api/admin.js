const express  = require('express');
const Blog     = require('../models/Blog');
const Survey   = require('../models/Survey');
const User     = require('../models/Users');
const Withdrawal    = require('../models/Withdrawal');
const Commission    = require('../models/Commission');
const Notification  = require('../models/Notification');
const WritingJob    = require('../models/WritingJob');
const Transcription = require('../models/Transcription');
const DataEntry     = require('../models/DataEntry');
const { uploadAudio, uploadDocument, deleteFile } = require('../config/cloudinary');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { PROFIT_PER_ACTIVATION, ACTIVATION_FEE } = require('../utils/commissionHelper');

const router = express.Router();

// ============================================================
// DEPOSIT BALANCE (fund a user's wallet before they activate)
// ============================================================
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
      transaction: {
        amount,
        previousBalance: prev,
        newBalance: user.primaryWallet.balance,
        reason,
        reference: reference || null,
        timestamp: new Date()
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// DASHBOARD STATS
// ============================================================
router.get('/dashboard/stats', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const [
      totalUsers, activeUsers, pendingUsers, suspendedUsers,
      notActivated, normalUsers, totalWithdrawalsPending,
      blogSubmissions, surveySubmissions,
      writingSubmissions, transcriptionSubmissions, dataEntrySubmissions
    ] = await Promise.all([
      User.countDocuments({ isAdmin: false }),
      User.countDocuments({ status: 'active',    isAdmin: false }),
      User.countDocuments({ status: 'pending',   isAdmin: false }),
      User.countDocuments({ status: 'suspended', isAdmin: false }),
      User.countDocuments({ packageType: 'not_active', isAdmin: false }),
      User.countDocuments({ packageType: 'normal',     isAdmin: false }),
      Withdrawal.countDocuments({ status: 'pending' }),
      Blog.countDocuments({ 'bids.bidStatus': 'submitted' }),
      Survey.countDocuments({ 'bids.bidStatus': 'submitted' }),
      WritingJob.countDocuments({ 'submissions.status': 'submitted' }),
      Transcription.countDocuments({ 'submissions.status': 'submitted' }),
      DataEntry.countDocuments({ 'submissions.status': 'submitted' })
    ]);

    const walletAgg = await User.aggregate([
      { $match: { isAdmin: false } },
      { $group: { _id: null, kesTotal: { $sum: '$primaryWallet.balance' }, ptsTotal: { $sum: '$pointsWallet.points' } } }
    ]);

    const totalRevenue    = normalUsers * ACTIVATION_FEE;
    const totalProfit     = normalUsers * PROFIT_PER_ACTIVATION;
    const paidPointsAgg   = await Withdrawal.aggregate([
      { $match: { type: 'points', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const pointsPayoutCost = paidPointsAgg[0]?.total || 0;

    res.json({
      users:    { total: totalUsers, active: activeUsers, pending: pendingUsers, suspended: suspendedUsers },
      packages: { notActivated, normal: normalUsers },
      pendingWithdrawals: totalWithdrawalsPending,
      pendingReviews: {
        blogs:         blogSubmissions,
        surveys:       surveySubmissions,
        writing:       writingSubmissions,
        transcription: transcriptionSubmissions,
        dataEntry:     dataEntrySubmissions,
        total:         blogSubmissions + surveySubmissions + writingSubmissions + transcriptionSubmissions + dataEntrySubmissions
      },
      totalKesInWallets:    walletAgg[0]?.kesTotal || 0,
      totalPointsInSystem:  walletAgg[0]?.ptsTotal || 0,
      profit: {
        totalRevenue,
        profitPool:       totalProfit,
        pointsPayoutsCost: pointsPayoutCost,
        netProfitPool:    totalProfit - pointsPayoutCost
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// P&L REPORT
// ============================================================
router.get('/profit-summary', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { period = 'all' } = req.query;
    let dateFilter = {};
    const now = new Date();
    if (period === 'week') {
      const w = new Date(now); w.setDate(w.getDate() - 7);
      dateFilter = { $gte: w };
    } else if (period === 'month') {
      const m = new Date(now); m.setMonth(m.getMonth() - 1);
      dateFilter = { $gte: m };
    }

    const userFilter = { packageType: 'normal', isAdmin: false };
    if (period !== 'all') userFilter.activatedAt = dateFilter;
    const activatedCount = await User.countDocuments(userFilter);

    const grossRevenue         = activatedCount * ACTIVATION_FEE;
    const profitFromActivations = activatedCount * PROFIT_PER_ACTIVATION;
    const commissionsPaid      = activatedCount * (ACTIVATION_FEE - PROFIT_PER_ACTIVATION);

    const wFilter = { type: 'points', status: 'completed' };
    if (period !== 'all') wFilter.processedAt = dateFilter;
    const pointsPayouts    = await Withdrawal.aggregate([{ $match: wFilter }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]);
    const pointsPayoutTotal = pointsPayouts[0]?.total || 0;
    const pointsPayoutCount = pointsPayouts[0]?.count || 0;

    const kesWFilter = { type: 'kes', status: 'completed' };
    if (period !== 'all') kesWFilter.processedAt = dateFilter;
    const kesPayouts    = await Withdrawal.aggregate([{ $match: kesWFilter }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]);
    const kesPayoutTotal = kesPayouts[0]?.total || 0;

    const netProfit = profitFromActivations - pointsPayoutTotal;

    const walletAgg = await User.aggregate([
      { $match: { isAdmin: false } },
      { $group: { _id: null, totalKes: { $sum: '$primaryWallet.balance' }, totalPts: { $sum: '$pointsWallet.points' } } }
    ]);
    const totalKesInWallets = walletAgg[0]?.totalKes || 0;
    const totalPtsInSystem  = walletAgg[0]?.totalPts  || 0;
    const totalPtsKesValue  = Math.floor(totalPtsInSystem / 100) * 10;

    res.json({
      period,
      activations: { count: activatedCount, grossRevenue, commissionsPaid, profitContribution: profitFromActivations },
      profitPool:  { total: profitFromActivations, pointsPayoutsCost: pointsPayoutTotal, pointsPayoutsCount: pointsPayoutCount, netProfit, netProfitMargin: profitFromActivations > 0 ? ((netProfit / profitFromActivations) * 100).toFixed(1) + '%' : '0%' },
      businessHealth: { totalKesInUserWallets: totalKesInWallets, totalKesWithdrawnByUsers: kesPayoutTotal, totalPointsInSystem: totalPtsInSystem, totalPointsOutstandingKesValue: totalPtsKesValue, totalLiability: totalKesInWallets + totalPtsKesValue },
      kesWithdrawals: { completedTotal: kesPayoutTotal, count: kesPayouts[0]?.count || 0 }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// TRANSACTION LEDGER
// ============================================================
router.get('/transactions', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { period = 'all', limit = 50, type } = req.query;
    let dateFilter = {};
    const now = new Date();
    if (period === 'week') { const w = new Date(now); w.setDate(w.getDate() - 7); dateFilter = { createdAt: { $gte: w } }; }
    else if (period === 'month') { const m = new Date(now); m.setMonth(m.getMonth() - 1); dateFilter = { createdAt: { $gte: m } }; }

    const wQuery = { ...dateFilter };
    if (type === 'kes') wQuery.type = 'kes';
    else if (type === 'points') wQuery.type = 'points';

    const withdrawals = await Withdrawal.find(wQuery)
      .sort({ createdAt: -1 }).limit(parseInt(limit))
      .populate('userId', 'username email');

    res.json({
      period,
      transactions: withdrawals.map(w => ({
        id: w._id, date: w.requestedAt,
        type: w.type === 'kes' ? 'KES Withdrawal' : 'Points Withdrawal',
        direction: 'out', paidFrom: w.type === 'kes' ? 'User Wallet' : 'Profit Pool',
        user: w.userId?.username || 'Unknown', email: w.userId?.email || '',
        amount: w.amount, pointsRedeemed: w.pointsRedeemed || 0,
        status: w.status, reference: w.transactionReference
      })),
      total: withdrawals.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// USER MANAGEMENT
// ============================================================
router.get('/users/all', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { status, packageType, page = 1, limit = 50 } = req.query;
    const filter = { isAdmin: false };
    if (status      && status      !== 'all') filter.status      = status;
    if (packageType && packageType !== 'all') filter.packageType = packageType;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [users, total] = await Promise.all([
      User.find(filter)
        .select('_id username email phone status packageType primaryWallet pointsWallet stats createdAt referrerId')
        .populate('referrerId', 'username email')
        .sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
      User.countDocuments(filter)
    ]);

    res.json({
      total, pages: Math.ceil(total / parseInt(limit)), currentPage: parseInt(page),
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
        referredBy: u.referrerId ? { id: u.referrerId._id, username: u.referrerId.username, email: u.referrerId.email, phone: u.referrerId.phone } : null,
        createdAt: u.createdAt
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

// ============================================================
// ── BLOG MANAGEMENT ─────────────────────────────────────────
// ============================================================
router.post('/blogs/create', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { title, description, content, category, deadline, maxBidders } = req.body;
    if (!title || !description || !content) {
      return res.status(400).json({ error: 'Title, description and content are required.' });
    }
    const blog = new Blog({
      title, description, content,
      category:   category || 'general',
      reward:     100,
      postedBy:   req.user.username || 'admin',
      postedAt:   new Date(),
      deadline:   deadline ? new Date(deadline) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      maxBidders: parseInt(maxBidders) || 50,
      status:     'open',
      bids:       []
    });
    await blog.save();
    res.status(201).json({ message: '✅ Blog created.', blog: { id: blog._id, title: blog.title, reward: blog.reward } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/blogs/all', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const blogs = await Blog.find().sort({ createdAt: -1 });
    res.json({
      blogs: blogs.map(b => ({
        id: b._id, title: b.title, description: b.description,
        category: b.category, reward: b.reward, status: b.status,
        maxBidders: b.maxBidders || 0,
        totalSubmissions: b.bids.length,
        pendingReview: b.bids.filter(bid => bid.bidStatus === 'submitted').length,
        approved:      b.bids.filter(bid => bid.bidStatus === 'approved').length,
        rejected:      b.bids.filter(bid => bid.bidStatus === 'rejected').length,
        slotsLeft: Math.max(0, (b.maxBidders || 0) - b.bids.filter(bid => ['submitted','approved'].includes(bid.bidStatus)).length),
        deadline: b.deadline, createdAt: b.createdAt
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/blogs/:blogId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { title, description, content, category, reward, status, maxBidders, deadline } = req.body;
    const blog = await Blog.findById(req.params.blogId);
    if (!blog) return res.status(404).json({ error: 'Blog not found' });
    if (title)      blog.title      = title;
    if (description) blog.description = description;
    if (content)    blog.content    = content;
    if (category)   blog.category   = category;
    if (reward)     blog.reward     = parseInt(reward);
    if (status)     blog.status     = status;
    if (maxBidders) blog.maxBidders = parseInt(maxBidders);
    if (deadline)   blog.deadline   = new Date(deadline);
    await blog.save();
    res.json({ message: '✅ Blog updated.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/blogs/:blogId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.blogId);
    if (!blog) return res.status(404).json({ error: 'Blog not found' });
    await Blog.deleteOne({ _id: blog._id });
    res.json({ message: '✅ Blog deleted.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/blogs/:blogId/submissions', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.blogId).populate('bids.userId', 'username email phone');
    if (!blog) return res.status(404).json({ error: 'Blog not found' });
    res.json({
      blogTitle: blog.title,
      submissions: blog.bids.map(b => ({
        userId: b.userId._id, username: b.userId.username,
        email: b.userId.email, phone: b.userId.phone,
        status: b.bidStatus, content: b.submissionContent,
        submittedAt: b.submittedAt, approvedAt: b.approvedAt,
        reviewNotes: b.reviewNotes, earnedPoints: b.earnedPoints
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/blogs/:blogId/approve/:userId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { blogId, userId } = req.params;
    const blog = await Blog.findById(blogId);
    if (!blog) return res.status(404).json({ error: 'Blog not found' });
    const bid = blog.bids.find(b => b.userId.toString() === userId && b.bidStatus === 'submitted');
    if (!bid) return res.status(404).json({ error: 'Submission not found or already reviewed.' });

    bid.bidStatus   = 'approved';
    bid.approvedAt  = new Date();
    bid.reviewNotes = req.body.reviewNotes || 'Approved';
    bid.earnedPoints = 100;
    await blog.save();

    const user = await User.findById(userId);
    user.pointsWallet.points      += 100;
    user.pointsWallet.totalEarned += 100;
    user.stats.blogsWritten        = (user.stats.blogsWritten || 0) + 1;
    user.stats.totalEarnings       = (user.stats.totalEarnings || 0) + 100;
    await user.save();

    await Commission.create({ fromUserId: userId, toUserId: userId, level: 1, amount: 100, type: 'blog_earning', status: 'completed', description: `Blog approved: ${blog.title} (+100 pts)` });
    await Notification.create({ userId, type: 'task_approved', title: '✅ Blog Approved!', message: `Your blog for "${blog.title}" was approved. You earned 100 points!`, metadata: { taskId: blog._id, taskType: 'blog', points: 100 } });

    res.json({ message: 'Blog approved. 100 points awarded.', pointsEarned: 100 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/blogs/:blogId/reject/:userId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { blogId, userId } = req.params;
    const blog = await Blog.findById(blogId);
    if (!blog) return res.status(404).json({ error: 'Blog not found' });
    const bid = blog.bids.find(b => b.userId.toString() === userId && b.bidStatus === 'submitted');
    if (!bid) return res.status(404).json({ error: 'Submission not found or already reviewed.' });

    bid.bidStatus   = 'rejected';
    bid.reviewNotes = req.body.reviewNotes || 'Did not meet requirements';
    bid.reviewedAt  = new Date();
    await blog.save();

    await Notification.create({ userId, type: 'task_rejected', title: '❌ Blog Rejected', message: `Your blog for "${blog.title}" was rejected. Reason: ${bid.reviewNotes}`, metadata: { taskId: blog._id, taskType: 'blog', reason: bid.reviewNotes } });
    res.json({ message: 'Blog submission rejected.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ── SURVEY MANAGEMENT ───────────────────────────────────────
// ============================================================
router.post('/surveys/create', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { title, description, questions, deadline, maxResponses } = req.body;
    if (!title || !description || !questions || !Array.isArray(questions)) {
      return res.status(400).json({ error: 'Title, description and questions array are required.' });
    }
    const processedQuestions = questions.map(q => {
      const obj = { question: q.question, type: q.type || 'text', options: q.options || [], required: q.required !== false, wordLimit: q.wordLimit || 0 };
      if (q.skipToQuestion && q.skipIfValue) { obj.skipToQuestion = parseInt(q.skipToQuestion) - 1; obj.skipIfValue = q.skipIfValue; }
      if (q.terminateIfValue) obj.terminateIfValue = q.terminateIfValue;
      return obj;
    });
    const survey = new Survey({
      title, description,
      questions: processedQuestions,
      reward:       100,
      postedBy:     req.user.username || 'admin',
      deadline:     deadline ? new Date(deadline) : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      maxResponses: parseInt(maxResponses) || 100,
      status:       'open',
      bids:         []
    });
    await survey.save();
    res.status(201).json({ message: '✅ Survey created.', survey: { id: survey._id, title: survey.title, questionsCount: survey.questions.length } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/surveys/all', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const surveys = await Survey.find().sort({ createdAt: -1 });
    res.json({
      surveys: surveys.map(s => ({
        id: s._id, title: s.title, description: s.description,
        questionsCount: s.questions.length, reward: s.reward, status: s.status,
        maxResponses: s.maxResponses || 0,
        totalSubmissions: s.bids.length,
        pendingReview: s.bids.filter(b => b.bidStatus === 'submitted').length,
        approved:      s.bids.filter(b => b.bidStatus === 'approved').length,
        rejected:      s.bids.filter(b => b.bidStatus === 'rejected').length,
        deadline: s.deadline, createdAt: s.createdAt
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/surveys/:surveyId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { title, description, status, maxResponses, deadline, reward } = req.body;
    const survey = await Survey.findById(req.params.surveyId);
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    if (title)       survey.title       = title;
    if (description) survey.description = description;
    if (status)      survey.status      = status;
    if (maxResponses) survey.maxResponses = parseInt(maxResponses);
    if (deadline)    survey.deadline    = new Date(deadline);
    if (reward)      survey.reward      = parseInt(reward);
    await survey.save();
    res.json({ message: '✅ Survey updated.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/surveys/:surveyId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const survey = await Survey.findById(req.params.surveyId);
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    await Survey.deleteOne({ _id: survey._id });
    res.json({ message: '✅ Survey deleted.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/surveys/:surveyId/submissions', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const survey = await Survey.findById(req.params.surveyId).populate('bids.userId', 'username email phone');
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    res.json({
      surveyTitle: survey.title,
      questions:   survey.questions,
      submissions: survey.bids.map(b => ({
        userId: b.userId._id, username: b.userId.username,
        email: b.userId.email, phone: b.userId.phone,
        status: b.bidStatus, responses: b.submissionContent,
        submittedAt: b.submittedAt, approvedAt: b.approvedAt,
        reviewNotes: b.reviewNotes, earnedPoints: b.earnedPoints
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/surveys/:surveyId/approve/:userId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { surveyId, userId } = req.params;
    const survey = await Survey.findById(surveyId);
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    const bid = survey.bids.find(b => b.userId.toString() === userId && b.bidStatus === 'submitted');
    if (!bid) return res.status(404).json({ error: 'Submission not found or already reviewed.' });

    bid.bidStatus   = 'approved';
    bid.approvedAt  = new Date();
    bid.reviewNotes = req.body.reviewNotes || 'Approved';
    bid.earnedPoints = 100;
    await survey.save();

    const user = await User.findById(userId);
    user.pointsWallet.points      += 100;
    user.pointsWallet.totalEarned += 100;
    user.stats.surveysCompleted    = (user.stats.surveysCompleted || 0) + 1;
    user.stats.totalEarnings       = (user.stats.totalEarnings || 0) + 100;
    await user.save();

    await Commission.create({ fromUserId: userId, toUserId: userId, level: 1, amount: 100, type: 'survey_earning', status: 'completed', description: `Survey approved: ${survey.title} (+100 pts)` });
    await Notification.create({ userId, type: 'task_approved', title: '✅ Survey Approved!', message: `Your survey for "${survey.title}" was approved. You earned 100 points!`, metadata: { taskId: survey._id, taskType: 'survey', points: 100 } });

    res.json({ message: 'Survey approved. 100 points awarded.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/surveys/:surveyId/reject/:userId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { surveyId, userId } = req.params;
    const survey = await Survey.findById(surveyId);
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    const bid = survey.bids.find(b => b.userId.toString() === userId && b.bidStatus === 'submitted');
    if (!bid) return res.status(404).json({ error: 'Submission not found or already reviewed.' });

    bid.bidStatus   = 'rejected';
    bid.reviewNotes = req.body.reviewNotes || 'Did not meet requirements';
    bid.reviewedAt  = new Date();
    await survey.save();

    await Notification.create({ userId, type: 'task_rejected', title: '❌ Survey Rejected', message: `Your survey for "${survey.title}" was rejected. Reason: ${bid.reviewNotes}`, metadata: { taskId: survey._id, taskType: 'survey', reason: bid.reviewNotes } });
    res.json({ message: 'Survey submission rejected.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ── WRITING JOB MANAGEMENT ──────────────────────────────────
// ============================================================
router.post('/writing/create', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { title, description, instructions, wordCount, format, reward, maxWorkers, deadline } = req.body;
    if (!title || !description || !instructions) {
      return res.status(400).json({ error: 'Title, description and instructions are required.' });
    }
    const job = new WritingJob({
      title: title.trim(), description: description.trim(), instructions: instructions.trim(),
      wordCount: wordCount || null, format: format || null,
      reward:     parseInt(reward)     || 100,
      maxWorkers: parseInt(maxWorkers) || 50,
      deadline:   deadline ? new Date(deadline) : null
    });
    await job.save();
    res.status(201).json({ message: '✅ Writing job created.', job: { id: job._id, title: job.title } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/writing/all', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const jobs = await WritingJob.find().sort({ postedAt: -1 });
    res.json({
      jobs: jobs.map(job => ({
        id: job._id, title: job.title, description: job.description,
        reward: job.reward, status: job.status, maxWorkers: job.maxWorkers,
        totalSubmissions: job.submissions.length,
        pending:  job.submissions.filter(s => s.status === 'submitted').length,
        approved: job.submissions.filter(s => s.status === 'approved').length,
        rejected: job.submissions.filter(s => s.status === 'rejected').length,
        postedAt: job.postedAt
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/writing/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { title, description, instructions, reward, status, maxWorkers, wordCount, format, deadline } = req.body;
    const job = await WritingJob.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (title)        job.title        = title;
    if (description)  job.description  = description;
    if (instructions) job.instructions = instructions;
    if (reward)       job.reward       = parseInt(reward);
    if (status)       job.status       = status;
    if (maxWorkers)   job.maxWorkers   = parseInt(maxWorkers);
    if (wordCount)    job.wordCount    = wordCount;
    if (format)       job.format       = format;
    if (deadline)     job.deadline     = new Date(deadline);
    await job.save();
    res.json({ message: '✅ Writing job updated.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/writing/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const job = await WritingJob.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    await WritingJob.deleteOne({ _id: job._id });
    res.json({ message: '✅ Writing job deleted.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/writing/:id/submissions', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const job = await WritingJob.findById(req.params.id).populate('submissions.userId', 'username email phone');
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({
      jobTitle: job.title, instructions: job.instructions,
      submissions: job.submissions.map(s => ({
        submissionId: s._id, userId: s.userId._id, username: s.userId.username,
        email: s.userId.email, phone: s.userId.phone, status: s.status,
        fileUrl: s.fileUrl, fileName: s.fileName, fileType: s.fileType,
        submittedAt: s.submittedAt, reviewedAt: s.reviewedAt,
        reviewNotes: s.reviewNotes, earnedPoints: s.earnedPoints
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/writing/:id/approve/:userId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const job = await WritingJob.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const sub = job.submissions.find(s => s.userId.toString() === req.params.userId && s.status === 'submitted');
    if (!sub) return res.status(404).json({ error: 'Submission not found or already reviewed.' });

    sub.status       = 'approved';
    sub.reviewedAt   = new Date();
    sub.reviewNotes  = req.body.notes || null;
    sub.earnedPoints = job.reward;
    await job.save();

    await User.findByIdAndUpdate(req.params.userId, {
      $inc: { 'pointsWallet.points': job.reward, 'pointsWallet.totalEarned': job.reward, 'stats.totalEarnings': job.reward }
    });
    await Commission.create({ fromUserId: req.params.userId, toUserId: req.params.userId, level: 1, amount: job.reward, type: 'writing_earning', status: 'completed', description: `Writing approved: ${job.title}` });
    await Notification.create({ userId: req.params.userId, type: 'task_approved', title: '✅ Writing Job Approved!', message: `Your submission for "${job.title}" was approved. You earned ${job.reward} points!`, metadata: { taskId: job._id, taskType: 'writing', points: job.reward } });

    res.json({ message: `✅ Approved. ${job.reward} points awarded.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/writing/:id/reject/:userId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const job = await WritingJob.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const sub = job.submissions.find(s => s.userId.toString() === req.params.userId && s.status === 'submitted');
    if (!sub) return res.status(404).json({ error: 'Submission not found or already reviewed.' });

    sub.status      = 'rejected';
    sub.reviewedAt  = new Date();
    sub.reviewNotes = req.body.reason || 'Did not meet requirements';
    await job.save();

    await Notification.create({ userId: req.params.userId, type: 'task_rejected', title: '❌ Writing Job Rejected', message: `Your submission for "${job.title}" was rejected. Reason: ${sub.reviewNotes}`, metadata: { taskId: job._id, taskType: 'writing', reason: sub.reviewNotes } });
    res.json({ message: 'Submission rejected.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ── TRANSCRIPTION MANAGEMENT ────────────────────────────────
// ============================================================
router.post('/transcription/create', authMiddleware, requireAdmin,
  uploadAudio.single('audio'),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Audio file is required.' });
      const { title, description, instructions, reward, maxWorkers, deadline } = req.body;
      if (!title || !description || !instructions) {
        return res.status(400).json({ error: 'Title, description and instructions are required.' });
      }
      const job = new Transcription({
        title: title.trim(), description: description.trim(), instructions: instructions.trim(),
        audioUrl:      req.file.path,
        audioPublicId: req.file.filename,
        reward:     parseInt(reward)     || 50,
        maxWorkers: parseInt(maxWorkers) || 50,
        deadline:   deadline ? new Date(deadline) : null
      });
      await job.save();
      res.status(201).json({ message: '✅ Transcription job created.', job: { id: job._id, title: job.title, audioUrl: job.audioUrl } });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

router.get('/transcription/all', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const jobs = await Transcription.find().sort({ postedAt: -1 });
    res.json({
      jobs: jobs.map(job => ({
        id: job._id, title: job.title, description: job.description,
        audioUrl: job.audioUrl, reward: job.reward, status: job.status,
        maxWorkers: job.maxWorkers,
        totalSubmissions: job.submissions.length,
        pending:  job.submissions.filter(s => s.status === 'submitted').length,
        approved: job.submissions.filter(s => s.status === 'approved').length,
        rejected: job.submissions.filter(s => s.status === 'rejected').length,
        postedAt: job.postedAt
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/transcription/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { title, description, instructions, reward, status, maxWorkers, deadline } = req.body;
    const job = await Transcription.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (title)        job.title        = title;
    if (description)  job.description  = description;
    if (instructions) job.instructions = instructions;
    if (reward)       job.reward       = parseInt(reward);
    if (status)       job.status       = status;
    if (maxWorkers)   job.maxWorkers   = parseInt(maxWorkers);
    if (deadline)     job.deadline     = new Date(deadline);
    await job.save();
    res.json({ message: '✅ Transcription job updated.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/transcription/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const job = await Transcription.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.audioPublicId) await deleteFile(job.audioPublicId, 'video');
    await Transcription.deleteOne({ _id: job._id });
    res.json({ message: '✅ Transcription job deleted.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/transcription/:id/submissions', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const job = await Transcription.findById(req.params.id).populate('submissions.userId', 'username email phone');
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({
      jobTitle: job.title, instructions: job.instructions, audioUrl: job.audioUrl,
      submissions: job.submissions.map(s => ({
        submissionId: s._id, userId: s.userId._id, username: s.userId.username,
        email: s.userId.email, status: s.status, content: s.content,
        submittedAt: s.submittedAt, reviewedAt: s.reviewedAt,
        reviewNotes: s.reviewNotes, earnedPoints: s.earnedPoints
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/transcription/:id/approve/:userId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const job = await Transcription.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const sub = job.submissions.find(s => s.userId.toString() === req.params.userId && s.status === 'submitted');
    if (!sub) return res.status(404).json({ error: 'Submission not found or already reviewed.' });

    sub.status       = 'approved';
    sub.reviewedAt   = new Date();
    sub.reviewNotes  = req.body.notes || null;
    sub.earnedPoints = job.reward;
    await job.save();

    await User.findByIdAndUpdate(req.params.userId, {
      $inc: { 'pointsWallet.points': job.reward, 'pointsWallet.totalEarned': job.reward, 'stats.totalEarnings': job.reward }
    });
    await Commission.create({ fromUserId: req.params.userId, toUserId: req.params.userId, level: 1, amount: job.reward, type: 'transcription_earning', status: 'completed', description: `Transcription approved: ${job.title}` });
    await Notification.create({ userId: req.params.userId, type: 'task_approved', title: '✅ Transcription Approved!', message: `Your transcription for "${job.title}" was approved. You earned ${job.reward} points!`, metadata: { taskId: job._id, taskType: 'transcription', points: job.reward } });

    res.json({ message: `✅ Approved. ${job.reward} points awarded.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/transcription/:id/reject/:userId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const job = await Transcription.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const sub = job.submissions.find(s => s.userId.toString() === req.params.userId && s.status === 'submitted');
    if (!sub) return res.status(404).json({ error: 'Submission not found or already reviewed.' });

    sub.status      = 'rejected';
    sub.reviewedAt  = new Date();
    sub.reviewNotes = req.body.reason || 'Did not meet requirements';
    await job.save();

    await Notification.create({ userId: req.params.userId, type: 'task_rejected', title: '❌ Transcription Rejected', message: `Your transcription for "${job.title}" was rejected. Reason: ${sub.reviewNotes}`, metadata: { taskId: job._id, taskType: 'transcription', reason: sub.reviewNotes } });
    res.json({ message: 'Submission rejected.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// ── DATA ENTRY MANAGEMENT ───────────────────────────────────
// ============================================================
router.post('/dataentry/create', authMiddleware, requireAdmin,
  uploadDocument.single('template'),
  async (req, res) => {
    try {
      const { title, description, instructions, reward, maxWorkers, deadline } = req.body;
      if (!title || !description || !instructions) {
        return res.status(400).json({ error: 'Title, description and instructions are required.' });
      }
      const job = new DataEntry({
        title: title.trim(), description: description.trim(), instructions: instructions.trim(),
        templateUrl:      req.file ? req.file.path     : null,
        templatePublicId: req.file ? req.file.filename : null,
        reward:     parseInt(reward)     || 75,
        maxWorkers: parseInt(maxWorkers) || 50,
        deadline:   deadline ? new Date(deadline) : null
      });
      await job.save();
      res.status(201).json({ message: '✅ Data entry job created.', job: { id: job._id, title: job.title } });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }
);

router.get('/dataentry/all', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const jobs = await DataEntry.find().sort({ postedAt: -1 });
    res.json({
      jobs: jobs.map(job => ({
        id: job._id, title: job.title, description: job.description,
        reward: job.reward, status: job.status, maxWorkers: job.maxWorkers,
        templateUrl: job.templateUrl,
        totalSubmissions: job.submissions.length,
        pending:  job.submissions.filter(s => s.status === 'submitted').length,
        approved: job.submissions.filter(s => s.status === 'approved').length,
        rejected: job.submissions.filter(s => s.status === 'rejected').length,
        postedAt: job.postedAt
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/dataentry/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { title, description, instructions, reward, status, maxWorkers, deadline } = req.body;
    const job = await DataEntry.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (title)        job.title        = title;
    if (description)  job.description  = description;
    if (instructions) job.instructions = instructions;
    if (reward)       job.reward       = parseInt(reward);
    if (status)       job.status       = status;
    if (maxWorkers)   job.maxWorkers   = parseInt(maxWorkers);
    if (deadline)     job.deadline     = new Date(deadline);
    await job.save();
    res.json({ message: '✅ Data entry job updated.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/dataentry/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const job = await DataEntry.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.templatePublicId) await deleteFile(job.templatePublicId);
    await DataEntry.deleteOne({ _id: job._id });
    res.json({ message: '✅ Data entry job deleted.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/dataentry/:id/submissions', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const job = await DataEntry.findById(req.params.id).populate('submissions.userId', 'username email phone');
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({
      jobTitle: job.title, instructions: job.instructions, templateUrl: job.templateUrl,
      submissions: job.submissions.map(s => ({
        submissionId: s._id, userId: s.userId._id, username: s.userId.username,
        email: s.userId.email, status: s.status, fileUrl: s.fileUrl,
        fileName: s.fileName, fileType: s.fileType,
        submittedAt: s.submittedAt, reviewedAt: s.reviewedAt,
        reviewNotes: s.reviewNotes, earnedPoints: s.earnedPoints
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/dataentry/:id/approve/:userId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const job = await DataEntry.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const sub = job.submissions.find(s => s.userId.toString() === req.params.userId && s.status === 'submitted');
    if (!sub) return res.status(404).json({ error: 'Submission not found or already reviewed.' });

    sub.status       = 'approved';
    sub.reviewedAt   = new Date();
    sub.reviewNotes  = req.body.notes || null;
    sub.earnedPoints = job.reward;
    await job.save();

    await User.findByIdAndUpdate(req.params.userId, {
      $inc: { 'pointsWallet.points': job.reward, 'pointsWallet.totalEarned': job.reward, 'stats.totalEarnings': job.reward }
    });
    await Commission.create({ fromUserId: req.params.userId, toUserId: req.params.userId, level: 1, amount: job.reward, type: 'dataentry_earning', status: 'completed', description: `Data entry approved: ${job.title}` });
    await Notification.create({ userId: req.params.userId, type: 'task_approved', title: '✅ Data Entry Approved!', message: `Your submission for "${job.title}" was approved. You earned ${job.reward} points!`, metadata: { taskId: job._id, taskType: 'dataentry', points: job.reward } });

    res.json({ message: `✅ Approved. ${job.reward} points awarded.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/dataentry/:id/reject/:userId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const job = await DataEntry.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const sub = job.submissions.find(s => s.userId.toString() === req.params.userId && s.status === 'submitted');
    if (!sub) return res.status(404).json({ error: 'Submission not found or already reviewed.' });

    sub.status      = 'rejected';
    sub.reviewedAt  = new Date();
    sub.reviewNotes = req.body.reason || 'Did not meet requirements';
    await job.save();

    await Notification.create({ userId: req.params.userId, type: 'task_rejected', title: '❌ Data Entry Rejected', message: `Your submission for "${job.title}" was rejected. Reason: ${sub.reviewNotes}`, metadata: { taskId: job._id, taskType: 'dataentry', reason: sub.reviewNotes } });
    res.json({ message: 'Submission rejected.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
