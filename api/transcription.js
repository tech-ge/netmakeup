const express = require('express');
const Transcription = require('../models/Transcription');
const User = require('../models/Users');
const Notification = require('../models/Notification');
const Commission = require('../models/Commission');
const { deleteFile } = require('../config/cloudinary');
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



// ─────────────────────────────────────────────────────────────
// USER ROUTES
// ─────────────────────────────────────────────────────────────

// GET /api/transcriptions — list all open jobs for logged-in user
router.get('/', authMiddleware, async (req, res) => {
  try {
    const jobs = await Transcription.find({ status: 'open' }).sort({ postedAt: -1 });
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
          audioUrl: job.audioUrl,
          reward: job.reward,
          maxWorkers: job.maxWorkers,
          currentWorkers: job.submissions.length,
          slotsLeft,
          canSubmit: !submission && slotsLeft > 0,
          userSubmission: submission
            ? { status: submission.status, reviewNotes: submission.reviewNotes }
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

// GET /api/transcriptions/:id — get single job details
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const job = await Transcription.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const submission = job.getUserSubmission(req.userId.toString());
    res.json({
      job: {
        id: job._id,
        title: job.title,
        description: job.description,
        instructions: job.instructions,
        audioUrl: job.audioUrl,
        reward: job.reward,
        maxWorkers: job.maxWorkers,
        currentWorkers: job.submissions.length,
        slotsLeft: job.maxWorkers - job.submissions.length,
        postedAt: job.postedAt,
        deadline: job.deadline
      },
      userSubmission: submission || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/transcriptions/:id/submit — submit transcription text
router.post('/:id/submit', authMiddleware, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || content.trim().length < 20) {
      return res.status(400).json({ error: 'Transcription content is too short (min 20 characters).' });
    }

    const job = await Transcription.findById(req.params.id);
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

    job.submissions.push({
      userId: req.userId,
      content: content.trim(),
      status: 'submitted',
      submittedAt: new Date()
    });

    await job.save();

    res.status(201).json({
      message: '✅ Transcription submitted successfully! Pending admin review.',
      jobTitle: job.title
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────────────────────

// POST /api/transcriptions/admin/create
// Browser uploads audio DIRECTLY to Cloudinary, sends back the URL + publicId
router.post('/admin/create', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { title, description, instructions, reward, maxWorkers, deadline, audioUrl, audioPublicId } = req.body;

    if (!title || !description || !instructions) {
      return res.status(400).json({ error: 'Title, description and instructions are required.' });
    }
    if (!audioUrl) {
      return res.status(400).json({ error: 'Audio file is required. Please upload the audio first.' });
    }

    const job = new Transcription({
      title:         title.trim(),
      description:   description.trim(),
      instructions:  instructions.trim(),
      audioUrl,
      audioPublicId: audioPublicId || '',
      reward:        parseInt(reward) || 50,
      maxWorkers:    parseInt(maxWorkers) || 50,
      deadline:      deadline ? new Date(deadline) : null
    });

    await job.save();

    res.status(201).json({
      message: '✅ Transcription job created.',
      job: { id: job._id, title: job.title, audioUrl: job.audioUrl }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/transcriptions/admin/all — all jobs for admin management
router.get('/admin/all', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const jobs = await Transcription.find().sort({ postedAt: -1 });
    res.json({
      jobs: jobs.map(job => ({
        id: job._id,
        title: job.title,
        description: job.description,
        audioUrl: job.audioUrl,
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

// GET /api/transcriptions/admin/:id/submissions — view all submissions for a job
router.get('/admin/:id/submissions', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const job = await Transcription.findById(req.params.id)
      .populate('submissions.userId', 'username email phone');
    if (!job) return res.status(404).json({ error: 'Job not found' });

    res.json({
      jobTitle: job.title,
      instructions: job.instructions,
      audioUrl: job.audioUrl,
      submissions: job.submissions.map(s => ({
        submissionId: s._id,
        userId: s.userId._id,
        username: s.userId.username,
        email: s.userId.email,
        status: s.status,
        content: s.content,
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

// POST /api/transcriptions/admin/:id/approve/:userId
router.post('/admin/:id/approve/:userId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const job = await Transcription.findById(req.params.id);
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

    // Award points to user
    await User.findByIdAndUpdate(req.params.userId, {
      $inc: {
        'pointsWallet.points': job.reward,
        'pointsWallet.totalEarned': job.reward,
        'stats.totalEarnings': job.reward
      }
    });

    // Log commission
    const user = await User.findById(req.params.userId);
    await safeCommission({
      fromUserId: req.params.userId, toUserId: req.params.userId,
      level: 1, amount: job.reward, type: 'task_earning', status: 'completed',
      description: `Transcription approved: ${job.title}`
    });

    // Notify user
    await safeNotify({
      userId:  req.params.userId,
      type:    'task_approved',
      title:   '✅ Transcription Approved!',
      message: `Your transcription for "${job.title}" was approved. You earned ${job.reward} points!`,
      metadata: { taskId: job._id, taskType: 'transcription', points: job.reward }
    });

    res.json({ message: `✅ Approved. ${job.reward} points awarded.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/transcriptions/admin/:id/reject/:userId
router.post('/admin/:id/reject/:userId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    const job = await Transcription.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const submission = job.submissions.find(
      s => s.userId.toString() === req.params.userId && s.status === 'submitted'
    );
    if (!submission) return res.status(404).json({ error: 'Submission not found or already reviewed.' });

    submission.status = 'rejected';
    submission.reviewedAt = new Date();
    submission.reviewNotes = reason || 'Did not meet requirements';
    await job.save();

    // Notify user
    await safeNotify({
      userId:  req.params.userId,
      type:    'task_rejected',
      title:   '❌ Transcription Rejected',
      message: `Your transcription for "${job.title}" was rejected. Reason: ${submission.reviewNotes}`,
      metadata: { taskId: job._id, taskType: 'transcription', reason: submission.reviewNotes }
    });

    res.json({ message: 'Submission rejected.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/transcriptions/admin/:id — edit job details
router.put('/admin/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { title, description, instructions, reward, status, maxWorkers } = req.body;
    const job = await Transcription.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (title)        job.title = title;
    if (description)  job.description = description;
    if (instructions) job.instructions = instructions;
    if (reward)       job.reward = parseInt(reward);
    if (status)       job.status = status;
    if (maxWorkers)   job.maxWorkers = parseInt(maxWorkers);
    await job.save();

    res.json({ message: '✅ Job updated.', job: { id: job._id, title: job.title, status: job.status } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/transcriptions/admin/:id — delete job + audio from Cloudinary
router.delete('/admin/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const job = await Transcription.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Delete audio from Cloudinary
    if (job.audioPublicId) {
      await deleteFile(job.audioPublicId, 'video');
    }

    await Transcription.deleteOne({ _id: job._id });
    res.json({ message: '✅ Transcription job deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
