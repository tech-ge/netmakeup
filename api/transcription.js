const express       = require('express');
const Transcription = require('../models/Transcription');
const User          = require('../models/Users');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// GET /api/transcriptions — list all open jobs
router.get('/', authMiddleware, async (req, res) => {
  try {
    const jobs   = await Transcription.find({ status: 'open' }).sort({ postedAt: -1 });
    const userId = req.userId.toString();

    res.json({
      jobs: jobs.map(job => {
        const submission = job.getUserSubmission(userId);
        const slotsLeft  = job.maxWorkers - job.submissions.length;
        return {
          id:             job._id,
          title:          job.title,
          description:    job.description,
          instructions:   job.instructions,
          audioUrl:       job.audioUrl,
          reward:         job.reward,
          maxWorkers:     job.maxWorkers,
          currentWorkers: job.submissions.length,
          slotsLeft,
          canSubmit:      !submission && slotsLeft > 0,
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

// GET /api/transcriptions/:id
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const job = await Transcription.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const submission = job.getUserSubmission(req.userId.toString());
    res.json({
      job: {
        id: job._id, title: job.title, description: job.description,
        instructions: job.instructions, audioUrl: job.audioUrl,
        reward: job.reward, maxWorkers: job.maxWorkers,
        currentWorkers: job.submissions.length,
        slotsLeft: job.maxWorkers - job.submissions.length,
        postedAt: job.postedAt, deadline: job.deadline
      },
      userSubmission: submission || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/transcriptions/:id/submit
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
      userId:      req.userId,
      content:     content.trim(),
      status:      'submitted',
      submittedAt: new Date()
    });
    await job.save();

    res.status(201).json({
      message:  '✅ Transcription submitted! Pending admin review.',
      jobTitle: job.title
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
