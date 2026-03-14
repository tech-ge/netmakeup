const express = require('express');
const Survey = require('../models/Survey');
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



// Get all available surveys
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { status = 'open' } = req.query;
    const surveys = await Survey.find({ status }).sort({ postedAt: -1 });

    const surveysWithStatus = surveys.map(survey => {
      const userBid = survey.bids.find(b => b.userId.toString() === req.userId.toString());
      return {
        id: survey._id,
        title: survey.title,
        description: survey.description,
        reward: survey.reward,
        rewardLabel: `${survey.reward} points`,
        questionsCount: survey.questions.length,
        postedAt: survey.postedAt,
        deadline: survey.deadline,
        maxResponses: survey.maxResponses,
        currentResponses: survey.bids.length,
        status: survey.status,
        userBidStatus: userBid ? userBid.bidStatus : null,
        canSubmit: !userBid && survey.bids.length < survey.maxResponses
      };
    });

    res.json({ surveys: surveysWithStatus, total: surveys.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single survey with questions
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const survey = await Survey.findById(req.params.id);
    if (!survey) return res.status(404).json({ error: 'Survey not found' });

    const userBid = survey.bids.find(b => b.userId.toString() === req.userId.toString());

    res.json({
      survey: {
        id: survey._id,
        title: survey.title,
        description: survey.description,
        questions: survey.questions.map(q => ({
          question: q.question,
          type: q.type,
          options: q.options || [],
          required: q.required,
          // Send logic fields to frontend
          skipToQuestion: q.skipToQuestion,
          terminateIfValue: q.terminateIfValue,
          wordLimit: q.wordLimit
        })),
        reward: survey.reward,
        rewardLabel: `${survey.reward} points`,
        deadline: survey.deadline,
        status: survey.status,
        userBid: userBid ? {
          status: userBid.bidStatus,
          submittedAt: userBid.submittedAt,
          approvedAt: userBid.approvedAt,
          reviewNotes: userBid.reviewNotes
        } : null,
        alreadySubmitted: !!userBid
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Submit survey responses
router.post('/:id/submit', authMiddleware, async (req, res) => {
  try {
    const { responses } = req.body;

    if (!responses || !Array.isArray(responses) || responses.length === 0) {
      return res.status(400).json({ error: 'Survey responses required.' });
    }

    const user = await User.findById(req.userId);

    if (user.packageType === 'not_active') {
      return res.status(403).json({ error: 'Activate your package to submit surveys.' });
    }

    if (user.isAtPointsCap && user.isAtPointsCap()) {
      return res.status(400).json({ error: 'You have reached the 2,500 points cap. Please withdraw your points on Tuesday before submitting more tasks.' });
    }

    // Daily limit: max 2 surveys per day
    user.resetDailyTasksIfNeeded();
    if (user.dailyTasks.surveysCompleted >= 2) {
      return res.status(400).json({ error: 'Daily survey limit reached (2 per day). Come back tomorrow.' });
    }

    const survey = await Survey.findById(req.params.id);
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    if (survey.status !== 'open') return res.status(400).json({ error: 'Survey is not open.' });

    if (survey.hasUserBid(req.userId)) {
      return res.status(400).json({ error: 'You have already submitted this survey.' });
    }

    if (survey.bids.length >= survey.maxResponses) {
      return res.status(400).json({ error: 'Survey is full.' });
    }

    // Format responses with question context
    const formattedResponses = responses.map((answer, i) => ({
      questionIndex: i,
      question: survey.questions[i]?.question || '',
      questionType: survey.questions[i]?.type || 'text',
      answer: answer
    }));

    survey.bids.push({
      userId: req.userId,
      bidStatus: 'submitted',
      submissionContent: formattedResponses,
      submittedAt: new Date()
    });
    await survey.save();

    user.dailyTasks.surveysCompleted += 1;
    await user.save();

    res.json({
      message: '✅ Survey submitted. Awaiting review.',
      submittedAt: new Date(),
      dailySurveysLeft: 2 - user.dailyTasks.surveysCompleted
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get user's survey submissions
router.get('/user/my-submissions', authMiddleware, async (req, res) => {
  try {
    const surveys = await Survey.find({ 'bids.userId': req.userId }).sort({ createdAt: -1 });
    const mySubmissions = surveys.map(survey => {
      const userBid = survey.bids.find(b => b.userId.toString() === req.userId.toString());
      return {
        surveyId: survey._id,
        surveyTitle: survey.title,
        reward: survey.reward,
        rewardLabel: `${survey.reward} points`,
        bidStatus: userBid.bidStatus,
        submittedAt: userBid.submittedAt,
        approvedAt: userBid.approvedAt,
        reviewNotes: userBid.reviewNotes,
        // Include their answers for review
        myAnswers: userBid.submissionContent
      };
    });

    res.json({
      submissions: mySubmissions,
      stats: {
        total: mySubmissions.length,
        approved: mySubmissions.filter(s => s.bidStatus === 'approved').length,
        pending: mySubmissions.filter(s => s.bidStatus === 'submitted').length,
        rejected: mySubmissions.filter(s => s.bidStatus === 'rejected').length
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: Create survey with logic fields
router.post('/admin/create', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { title, description, questions, deadline, maxResponses } = req.body;
    
    if (!title || !description || !questions || !Array.isArray(questions)) {
      return res.status(400).json({ error: 'Title, description and questions are required.' });
    }

    // Process questions and save logic fields
    const processedQuestions = questions.map(q => {
      const questionObj = {
        question: q.question,
        type: q.type || 'text',
        options: q.options || [],
        required: q.required !== false,
        wordLimit: q.wordLimit || 0
      };

      // Add skip logic if provided
      if (q.skipToQuestion && q.skipIfValue) {
        questionObj.skipToQuestion = parseInt(q.skipToQuestion) - 1; // Convert to 0-based index
        questionObj.skipIfValue = q.skipIfValue;
      }

      // Add terminate logic if provided
      if (q.terminateIfValue) {
        questionObj.terminateIfValue = q.terminateIfValue;
      }

      return questionObj;
    });

    const survey = new Survey({
      title, 
      description,
      questions: processedQuestions,
      reward: 100,
      postedBy: req.user.username || 'admin',
      postedAt: new Date(),
      deadline: deadline ? new Date(deadline) : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      maxResponses: maxResponses || 100,
      status: 'open',
      bids: []
    });

    await survey.save();
    res.status(201).json({ 
      message: 'Survey created successfully.', 
      survey: { 
        id: survey._id, 
        title: survey.title, 
        reward: survey.reward,
        questionsCount: survey.questions.length
      } 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: Get all surveys (for management)
router.get('/admin/all', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const surveys = await Survey.find().sort({ postedAt: -1 });
    
    const surveyList = surveys.map(s => ({
      id: s._id,
      title: s.title,
      description: s.description,
      status: s.status,
      postedAt: s.postedAt,
      deadline: s.deadline,
      totalSubmissions: s.bids.length,
      pendingSubmissions: s.bids.filter(b => b.bidStatus === 'submitted').length,
      approvedSubmissions: s.bids.filter(b => b.bidStatus === 'approved').length,
      rejectedSubmissions: s.bids.filter(b => b.bidStatus === 'rejected').length,
      hasLogic: s.questions.some(q => q.skipToQuestion || q.terminateIfValue)
    }));

    res.json({ surveys: surveyList });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: Get pending survey submissions (with answers to review)
router.get('/admin/pending-submissions', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const surveys = await Survey.find({ 'bids.bidStatus': 'submitted' })
      .populate('bids.userId', 'username email phone');
    
    const pending = [];
    
    surveys.forEach(survey => {
      survey.bids
        .filter(b => b.bidStatus === 'submitted')
        .forEach(bid => {
          // Format the submission with all answers for review
          const answers = bid.submissionContent.map((answer, idx) => ({
            questionNumber: idx + 1,
            question: survey.questions[idx]?.question || 'Unknown question',
            questionType: survey.questions[idx]?.type || 'text',
            answer: answer.answer || answer, // Handle both formats
            required: survey.questions[idx]?.required || false
          }));

          pending.push({
            id: bid._id,
            surveyId: survey._id,
            surveyTitle: survey.title,
            surveyDescription: survey.description,
            userId: bid.userId._id,
            username: bid.userId.username,
            email: bid.userId.email,
            phone: bid.userId.phone,
            submittedAt: bid.submittedAt,
            answers: answers, // Full answers for review
            totalQuestions: survey.questions.length,
            questionsAnswered: answers.length
          });
        });
    });

    // Sort by newest first
    pending.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

    res.json({ 
      pending, 
      total: pending.length 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: Get single submission details for review
router.get('/admin/submission/:submissionId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { submissionId } = req.params;
    
    // Find survey containing this submission
    const survey = await Survey.findOne({ 'bids._id': submissionId })
      .populate('bids.userId', 'username email phone');
    
    if (!survey) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    const bid = survey.bids.id(submissionId);
    
    // Format answers with question details
    const answersWithQuestions = bid.submissionContent.map((answer, idx) => {
      const question = survey.questions[idx];
      return {
        questionNumber: idx + 1,
        question: question?.question || 'Unknown',
        type: question?.type || 'text',
        options: question?.options || [],
        answer: answer.answer || answer,
        required: question?.required || false,
        // Include logic info for context
        hadSkipLogic: !!question?.skipToQuestion,
        hadTerminateLogic: !!question?.terminateIfValue
      };
    });

    res.json({
      submission: {
        id: bid._id,
        surveyId: survey._id,
        surveyTitle: survey.title,
        surveyDescription: survey.description,
        user: {
          id: bid.userId._id,
          username: bid.userId.username,
          email: bid.userId.email,
          phone: bid.userId.phone
        },
        submittedAt: bid.submittedAt,
        answers: answersWithQuestions,
        status: bid.bidStatus,
        reviewNotes: bid.reviewNotes
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: Approve survey submission
router.post('/admin/:surveyId/approve/:userId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { surveyId, userId } = req.params;
    const { reviewNotes } = req.body;

    const survey = await Survey.findById(surveyId);
    if (!survey) return res.status(404).json({ error: 'Survey not found' });

    const userBid = survey.bids.find(b => b.userId.toString() === userId);
    if (!userBid) return res.status(404).json({ error: 'Submission not found' });

    if (userBid.bidStatus !== 'submitted') {
      return res.status(400).json({ error: `Cannot approve a ${userBid.bidStatus} submission.` });
    }

    userBid.bidStatus = 'approved';
    userBid.approvedAt = new Date();
    userBid.reviewNotes = reviewNotes || 'Approved';
    await survey.save();

    const pointsEarned = 100;
    const user = await User.findById(userId);
    user.pointsWallet.points += pointsEarned;
    user.pointsWallet.totalEarned += pointsEarned;
    user.stats.surveysCompleted = (user.stats.surveysCompleted || 0) + 1;
    user.stats.totalEarnings = (user.stats.totalEarnings || 0) + pointsEarned;
    await user.save();

    await new Commission({
      fromUserId: userId,
      toUserId: userId,
      level: 1,
      amount: pointsEarned,
      type: 'survey_earning',
      status: 'completed',
      description: `Survey approved: ${survey.title} (+${pointsEarned} pts)`
    }).save();

    await safeNotify({ userId, type: 'task_approved', title: '✅ Survey Approved!', message: `Your survey submission for "${survey.title}" was approved. You earned ${pointsEarned} points!`, metadata: { taskId: survey._id, taskType: 'survey', points: pointsEarned } });
    res.json({ message: `Survey approved. ${pointsEarned} points awarded.`, pointsEarned, newPoints: user.pointsWallet.points });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: Reject survey submission
router.post('/admin/:surveyId/reject/:userId', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { surveyId, userId } = req.params;
    const { reviewNotes } = req.body;

    const survey = await Survey.findById(surveyId);
    if (!survey) return res.status(404).json({ error: 'Survey not found' });

    const userBid = survey.bids.find(b => b.userId.toString() === userId);
    if (!userBid) return res.status(404).json({ error: 'Submission not found' });

    userBid.bidStatus = 'rejected';
    userBid.reviewNotes = reviewNotes || 'Rejected';
    userBid.reviewedAt = new Date();
    await survey.save();
    await safeNotify({ userId, type: 'task_rejected', title: '❌ Survey Rejected', message: `Your survey submission for "${survey.title}" was rejected. Reason: ${userBid.reviewNotes}`, metadata: { taskId: survey._id, taskType: 'survey', reason: userBid.reviewNotes } });
    res.json({ message: 'Submission rejected.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ADMIN: Edit survey
router.put('/admin/:id', authMiddleware, requireAdmin, async (req, res) => {
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
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: Close survey
router.post('/admin/:id/close', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const survey = await Survey.findById(req.params.id);
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    survey.isOpen = false;
    await survey.save();
    res.json({ message: 'Survey closed.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN: Delete survey
router.delete('/admin/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const survey = await Survey.findById(req.params.id);
    if (!survey) return res.status(404).json({ error: 'Survey not found' });
    await Survey.deleteOne({ _id: survey._id });
    res.json({ message: 'Survey deleted.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
