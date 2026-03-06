const express = require('express');
const WritingJob = require('../models/WritingJob');
const User = require('../models/Users');
const Notification = require('../models/Notification');
const Commission = require('../models/Commission');
const { uploadDocument, deleteFile } = require('../config/cloudinary');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

const router = express.Router();
// ── Safe side-effect helpers ──────────────────────────────────────────────────
async function safeNotify(payload) {
  try { await Notification.create(payload); }
  catch (e) { console.error('⚠️  Notification skipped:', e.message); }
}
async function safeCommission(payload) {
  try { await Commission.create(payload); }
  catch (e) { console.error('⚠️  Commission log skipped:', e.message); }
}



// ─────────────────────────────────────────────────────────────
// USER ROUTES
// ─────────────────────────────────────────────────────────────

// GET /api/writing — list all open writing jobs
router.get('/', authMiddleware, async (req, res) => {
  try {
    const jobs = await WritingJob.find({ status: 'open' }).sort({ postedAt: -1 });
    const userId = req.userId.toString();

    res.json({
      jobs: jobs.map(job => {
        const submission = job.getUserSubmission(userId);
        const slotsLeft = job.maxWorkers - job.submissions.length;
        return {
          id: job._id,
          title: job.title,
          description: job.description,
          instructions: job.instructions,
          wordCount: job.wordCount,
          format: job.format,
          reward: job.reward,
          maxWorkers: job.maxWorkers,
          currentWorkers: job.submissions.length,
          slotsLeft,
          canSubmit: !submission && slotsLeft > 0,
          userSubmission: submission
            ? { status: submission.status, fileUrl: submission.fileUrl, reviewNotes: submission.reviewNotes }
            : null,
          postedAt: job.postedAt,
          deadline: job.deadline
        };
      })
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/writing/:id — single job
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const job = await WritingJob.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const submission = job.getUserSubmission(req.userId.toString());
    res.json({ job, userSubmission: submission || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/writing/:id/submit — upload PDF/DOCX submission
router.post('/:id/submit', authMiddleware,
  uploadDocument.single('file'),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'A PDF or Word document is required.' });

      const job = await WritingJob.findById(req.params.id);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      if (job.status !== 'open') return res.status(400).json({ error: 'This job is no longer open.' });

      const user = await User.findById(req.userId);
      if (user.packageType === 'not_active') {
        return res.status(400).json({ error: 'Activate your account to submit tasks.' });
      }

      if (job.hasUserSubmitted(req.userId.toString())) {
        return res.status(400).json({ error: 'You have already submitted this job.' });
      }

      if (job.submissions.length >= job.maxWorkers) {
        return res.status(400).json({ error: 'All slots for this job are taken.' });
      }

      const ext = req.file.originalname.split('.').pop().toLowerCase();

      job.submissions.push({
        userId:      req.userId,
        fileUrl:     req.file.path,
        filePublicId: req.file.filename,
        fileName:    req.file.originalname,
        fileType:    ext,
        status:      'submitted',
        submittedAt: new Date()
      });

      await job.save();

      res.status(201).json({
        message: '✅ Writing submission uploaded! Pending admin review.',
        jobTitle: job.title
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─────────────────────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────────────────────

// POST /api/writing/admin/create — create a writing job
router.post('/admin/create', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { title, description, instructions, wordCount, format, reward, maxWorkers, deadline } = req.body;
    if (!title || !description || !instructions) {
      return res.status(400).json({ error: 'Title, description and instructions are required.' });
    }

    const job = new WritingJob({
      title:        title.trim(),
      description:  description.trim(),
      instructions: instructions.trim(),
      wordCount:    wordCount || null,
      format:       format || null,
      reward:       parseInt(reward) || 100,
      maxWorkers:   parseInt(maxWorkers) || 50,
      deadline:     deadline ? new Date(deadline) : null
    });

    await job.save();
    res.status(201).json({ message: '✅ Writing job created.', job: { id: job._id, title: job.title } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/writing/admin/all
router.get('/admin/all', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const jobs = await WritingJob.find().sort({ postedAt: -1 });
    res.json({
      jobs: jobs.map(job => ({
        id: job._id,
        title: job.title,
        description: job.description,
        reward: job.reward,
        status: job.status,
        maxWorkers: job.maxWorkers,
        totalSubmissions: job.submissions.length,
        pending:  job.submissions.filter(s => s.status === 'submitted').length,
        approved: job.submissions.filter(s => s.status === 'approved').length,
        rejected: job.submissions.filter(s => s.status === 'rejected').length,
        postedAt: job.postedAt
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/writing/admin/:id/submissions
router.get('/admin/:id/submissions', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const job = await WritingJob.findById(req.params.id)
      .populate('submissions.userId', 'username email phone');
    if (!job) return res.status(404).json({ error: 'Job not found' });

    res.json({
      jobTitle: job.title,
      instructions: job.instructions,
      submissions: job.submissions.map(s => ({
        submissionId: s._id,
        userId: s.userId._id,
        username: s.userId.username,
        email: s.userId.email,
        status: s.status,
        fileUrl: s.fileUrl,
        fileName: s.fileName,
        fileType: s.fileType,
        submittedAt: s.submittedAt,
        reviewedAt: s.reviewedAt,
        reviewNotes: s.reviewNotes,
        earnedPoints: s.earnedPoints
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/writing/admin/:id/approve/:userId
router.post('/admin/:id/approve/:userId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const job = await WritingJob.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const submission = job.submissions.find(
      s => s.userId.toString() === req.params.userId && s.status === 'submitted'
    );
    if (!submission) return res.status(404).json({ error: 'Submission not found or already reviewed.' });

    submission.status = 'approved';
    submission.reviewedAt = new Date();
    submission.reviewNotes = req.body.notes || null;
    submission.earnedPoints = job.reward;
    await job.save();

    await User.findByIdAndUpdate(req.params.userId, {
      $inc: {
        'pointsWallet.points': job.reward,
        'pointsWallet.totalEarned': job.reward,
        'stats.totalEarnings': job.reward
      }
    });

    await safeCommission({
      fromUserId: req.params.userId, toUserId: req.params.userId,
      level: 1, amount: job.reward, type: 'task_earning', status: 'completed',
      description: `Writing job approved: ${job.title}`
    });
    await safeNotify({
      userId: req.params.userId, type: 'task_approved', title: '✅ Writing Job Approved!',
      message: `Your submission for "${job.title}" was approved. You earned ${job.reward} points!`,
      metadata: { taskId: job._id, taskType: 'writing', points: job.reward }
    });

    res.json({ message: `✅ Approved. ${job.reward} points awarded.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/writing/admin/:id/reject/:userId
router.post('/admin/:id/reject/:userId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    const job = await WritingJob.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const submission = job.submissions.find(
      s => s.userId.toString() === req.params.userId && s.status === 'submitted'
    );
    if (!submission) return res.status(404).json({ error: 'Submission not found or already reviewed.' });

    submission.status = 'rejected';
    submission.reviewedAt = new Date();
    submission.reviewNotes = reason || 'Did not meet requirements';
    await job.save();

    await safeNotify({
      userId: req.params.userId, type: 'task_rejected', title: '❌ Writing Job Rejected',
      message: `Your submission for "${job.title}" was rejected. Reason: ${submission.reviewNotes}`,
      metadata: { taskId: job._id, taskType: 'writing', reason: submission.reviewNotes }
    });

    res.json({ message: 'Submission rejected.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/writing/admin/:id
router.put('/admin/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { title, description, instructions, reward, status, maxWorkers, wordCount, format } = req.body;
    const job = await WritingJob.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (title)        job.title = title;
    if (description)  job.description = description;
    if (instructions) job.instructions = instructions;
    if (reward)       job.reward = parseInt(reward);
    if (status)       job.status = status;
    if (maxWorkers)   job.maxWorkers = parseInt(maxWorkers);
    if (wordCount)    job.wordCount = wordCount;
    if (format)       job.format = format;
    await job.save();

    res.json({ message: '✅ Job updated.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/writing/admin/:id
router.delete('/admin/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const job = await WritingJob.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    await WritingJob.deleteOne({ _id: job._id });
    res.json({ message: '✅ Writing job deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
