const express    = require('express');
const DataEntry  = require('../models/DataEntry');
const User       = require('../models/Users');
const { uploadDocument } = require('../config/cloudinary');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// GET /api/dataentry — list all open data entry jobs
router.get('/', authMiddleware, async (req, res) => {
  try {
    const jobs   = await DataEntry.find({ status: 'open' }).sort({ postedAt: -1 });
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
          templateUrl:    job.templateUrl,
          reward:         job.reward,
          maxWorkers:     job.maxWorkers,
          currentWorkers: job.submissions.length,
          slotsLeft,
          canSubmit:      !submission && slotsLeft > 0,
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

// GET /api/dataentry/:id
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const job = await DataEntry.findById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const submission = job.getUserSubmission(req.userId.toString());
    res.json({ job, userSubmission: submission || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dataentry/:id/submit
router.post('/:id/submit', authMiddleware,
  uploadDocument.single('file'),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'A PDF or Word document is required.' });

      const job = await DataEntry.findById(req.params.id);
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
        userId:       req.userId,
        fileUrl:      req.file.path,
        filePublicId: req.file.filename,
        fileName:     req.file.originalname,
        fileType:     ext,
        status:       'submitted',
        submittedAt:  new Date()
      });
      await job.save();

      res.status(201).json({
        message:  '✅ Data entry submission uploaded! Pending admin review.',
        jobTitle: job.title
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
