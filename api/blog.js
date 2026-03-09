const express = require('express');
const Blog = require('../models/Blog');
const User = require('../models/Users');
const Commission = require('../models/Commission');
const Notification = require('../models/Notification');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

const router = express.Router();
// ── Safe side-effect helpers: notification/commission failures never crash approvals ──
async function safeNotify(payload) {
  try { await Notification.create(payload); }
  catch (e) { console.error('⚠️  Notification skipped:', e.message); }
}
async function safeCommission(payload) {
  try { await Commission.create(payload); }
  catch (e) { console.error('⚠️  Commission log skipped:', e.message); }
}



// Get all available blogs
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { status = 'open' } = req.query;
    const blogs = await Blog.find({ status }).sort({ postedAt: -1 });

    const blogsWithStatus = blogs.map(blog => {
      const userBid = blog.bids.find(b => b.userId.toString() === req.userId.toString());
      return {
        id: blog._id,
        title: blog.title,
        description: blog.description,
        category: blog.category,
        reward: blog.reward,
        rewardLabel: `${blog.reward} points`,
        postedAt: blog.postedAt,
        deadline: blog.deadline,
        maxBidders: blog.maxBidders,
        currentBidders: blog.bids.length,
        status: blog.status,
        userBidStatus: userBid ? userBid.bidStatus : null,
        canBid: !userBid && blog.bids.length < blog.maxBidders
      };
    });

    res.json({ blogs: blogsWithStatus, total: blogs.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single blog
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id).populate('bids.userId', 'username');
    if (!blog) return res.status(404).json({ error: 'Blog not found' });

    const userBid = blog.bids.find(b => b.userId._id.toString() === req.userId.toString());

    res.json({
      blog: {
        id: blog._id,
        title: blog.title,
        description: blog.description,
        content: blog.content,
        category: blog.category,
        reward: blog.reward,
        rewardLabel: `${blog.reward} points`,
        postedAt: blog.postedAt,
        deadline: blog.deadline,
        status: blog.status,
        userBid: userBid ? {
          status: userBid.bidStatus,
          submittedAt: userBid.submittedAt,
          approvedAt: userBid.approvedAt,
          reviewNotes: userBid.reviewNotes
        } : null
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Submit blog work (this creates the bid + submission in one step)
router.post('/:id/submit', authMiddleware, async (req, res) => {
  try {
    const { submissionContent } = req.body;

    if (!submissionContent || submissionContent.trim().length < 100) {
      return res.status(400).json({ error: 'Blog content must be at least 100 characters.' });
    }

    const user = await User.findById(req.userId);

    if (user.packageType === 'not_active') {
      return res.status(403).json({ error: 'Activate your package to submit blogs.' });
    }

    // Check daily limit: max 2 blogs per day
    user.resetDailyTasksIfNeeded();
    if (user.dailyTasks.blogsCompleted >= 2) {
      return res.status(400).json({ error: 'Daily blog limit reached (2 per day). Come back tomorrow.' });
    }

    const blog = await Blog.findById(req.params.id);
    if (!blog) return res.status(404).json({ error: 'Blog not found' });
    if (blog.status !== 'open') return res.status(400).json({ error: 'Blog is not open for submissions.' });

    if (blog.hasUserBid(req.userId)) {
      return res.status(400).json({ error: 'You have already submitted this blog.' });
    }

    if (blog.bids.length >= blog.maxBidders) {
      return res.status(400).json({ error: 'This blog has reached its maximum submissions.' });
    }

    // Add submission
    blog.bids.push({
      userId: req.userId,
      bidStatus: 'submitted',
      submissionContent: submissionContent.trim(),
      submittedAt: new Date()
    });
    await blog.save();

    // Increment daily blog count
    user.dailyTasks.blogsCompleted += 1;
    await user.save();

    res.json({
      message: '✅ Blog submitted. Awaiting admin review.',
      submittedAt: new Date(),
      dailyBlogsLeft: 2 - user.dailyTasks.blogsCompleted
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get user's blog submissions
router.get('/user/my-submissions', authMiddleware, async (req, res) => {
  try {
    const blogs = await Blog.find({ 'bids.userId': req.userId }).sort({ createdAt: -1 });
    const mySubmissions = blogs.map(blog => {
      const userBid = blog.bids.find(b => b.userId.toString() === req.userId.toString());
      return {
        blogId: blog._id,
        blogTitle: blog.title,
        reward: blog.reward,
        rewardLabel: `${blog.reward} points`,
        bidStatus: userBid.bidStatus,
        submittedAt: userBid.submittedAt,
        approvedAt: userBid.approvedAt,
        reviewNotes: userBid.reviewNotes
      };
    });

    res.json({
      submissions: mySubmissions,
      stats: {
        total: mySubmissions.length,
        approved: mySubmissions.filter(b => b.bidStatus === 'approved').length,
        pending: mySubmissions.filter(b => b.bidStatus === 'submitted').length,
        rejected: mySubmissions.filter(b => b.bidStatus === 'rejected').length
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: Create blog
router.post('/admin/create', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { title, description, content, category, deadline, maxBidders } = req.body;
    if (!title || !description || !content) {
      return res.status(400).json({ error: 'Title, description and content are required.' });
    }

    const blog = new Blog({
      title, description, content,
      category: category || 'general',
      reward: 100, // always 100 points
      postedBy: req.user.username || 'admin',
      postedAt: new Date(),
      deadline: deadline ? new Date(deadline) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      maxBidders: maxBidders || 50,
      status: 'open',
      bids: []
    });

    await blog.save();
    res.status(201).json({ message: 'Blog created.', blog: { id: blog._id, title: blog.title, reward: blog.reward } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: Approve submission (awards 100 points)
router.post('/admin/:blogId/approve/:userId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { blogId, userId } = req.params;
    const { reviewNotes } = req.body;

    const blog = await Blog.findById(blogId);
    if (!blog) return res.status(404).json({ error: 'Blog not found' });

    const userBid = blog.bids.find(b => b.userId.toString() === userId);
    if (!userBid) return res.status(404).json({ error: 'Submission not found' });

    if (userBid.bidStatus !== 'submitted') {
      return res.status(400).json({ error: `Cannot approve a ${userBid.bidStatus} submission.` });
    }

    userBid.bidStatus = 'approved';
    userBid.approvedAt = new Date();
    userBid.reviewNotes = reviewNotes || 'Approved';
    await blog.save();

    // Award 100 points
    const pointsEarned = 100;
    const user = await User.findById(userId);
    user.pointsWallet.points += pointsEarned;
    user.pointsWallet.totalEarned += pointsEarned;
    user.stats.blogsWritten = (user.stats.blogsWritten || 0) + 1;
    user.stats.totalEarnings = (user.stats.totalEarnings || 0) + pointsEarned;
    await user.save();

    await new Commission({
      fromUserId: userId,
      toUserId: userId,
      level: 1,
      amount: pointsEarned,
      type: 'blog_earning',
      status: 'completed',
      description: `Blog approved: ${blog.title} (+${pointsEarned} pts)`
    }).save();

    await safeNotify({ userId, type: 'task_approved', title: '✅ Blog Approved!', message: `Your blog submission for "${blog.title}" was approved. You earned ${pointsEarned} points!`, metadata: { taskId: blog._id, taskType: 'blog', points: pointsEarned } });
    res.json({ message: `Blog approved. ${pointsEarned} points awarded.`, pointsEarned, newPoints: user.pointsWallet.points });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: Reject submission
router.post('/admin/:blogId/reject/:userId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { blogId, userId } = req.params;
    const { reviewNotes } = req.body;

    const blog = await Blog.findById(blogId);
    if (!blog) return res.status(404).json({ error: 'Blog not found' });

    const userBid = blog.bids.find(b => b.userId.toString() === userId);
    if (!userBid) return res.status(404).json({ error: 'Submission not found' });

    userBid.bidStatus = 'rejected';
    userBid.reviewNotes = reviewNotes || 'Rejected';
    userBid.reviewedAt = new Date();
    await blog.save();

    await safeNotify({ userId, type: 'task_rejected', title: '❌ Blog Rejected', message: `Your blog submission for "${blog.title}" was rejected. Reason: ${userBid.reviewNotes}`, metadata: { taskId: blog._id, taskType: 'blog', reason: userBid.reviewNotes } });
    res.json({ message: 'Submission rejected.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: Get all submissions pending review
router.get('/admin/pending-submissions', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const blogs = await Blog.find({ 'bids.bidStatus': 'submitted' }).populate('bids.userId', 'username email');
    const pending = [];
    blogs.forEach(blog => {
      blog.bids.filter(b => b.bidStatus === 'submitted').forEach(bid => {
        pending.push({
          blogId: blog._id,
          blogTitle: blog.title,
          userId: bid.userId._id,
          username: bid.userId.username,
          email: bid.userId.email,
          submittedAt: bid.submittedAt,
          content: bid.submissionContent?.substring(0, 200) + '...'
        });
      });
    });

    res.json({ pending, total: pending.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ADMIN: Edit blog
router.put('/admin/:id', authMiddleware, requireAdmin, async (req, res) => {
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
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: Close blog (stop accepting new bids)
router.post('/admin/:id/close', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) return res.status(404).json({ error: 'Blog not found' });
    blog.isOpen = false;
    await blog.save();
    res.json({ message: 'Blog closed.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: Delete blog
router.delete('/admin/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) return res.status(404).json({ error: 'Blog not found' });
    await Blog.deleteOne({ _id: blog._id });
    res.json({ message: 'Blog deleted.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
