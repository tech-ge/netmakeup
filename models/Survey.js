const mongoose = require('mongoose');

const SurveySchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, required: true, maxlength: 1000 },
 questions: [{
  question: { type: String, required: true },
  type: { type: String, enum: ['text', 'number', 'multiple_choice', 'rating', 'yes_no'], default: 'text' },
  options: [{ type: String }],
  required: { type: Boolean, default: true },
  wordLimit: { type: Number, default: 0 },
  minValue: { type: Number, default: null },
  maxValue: { type: Number, default: null },
  maxChoices: { type: Number, default: 1 },
  skipToQuestion: { type: Number, default: null },
  skipIfValue: { type: String, default: null },
  terminateIfValue: { type: String, default: null }
}],
  reward: { type: Number, default: 100 }, // 100 points per approved survey
  postedBy: { type: String, default: 'admin' },
  postedAt: { type: Date, default: Date.now },
  deadline: { type: Date, default: null },
  maxResponses: { type: Number, default: 100 },
  status: {
    type: String,
    enum: ['open', 'in_progress', 'completed', 'cancelled'],
    default: 'open'
  },
  bids: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    bidStatus: {
      type: String,
      enum: ['bidded', 'active', 'submitted', 'approved', 'rejected'],
      default: 'bidded'
    },
    submissionContent: { type: mongoose.Schema.Types.Mixed, default: null },
    submittedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    reviewNotes: { type: String, default: null },
    earnedPoints: { type: Number, default: 100 }
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

SurveySchema.pre('save', function (next) { this.updatedAt = Date.now(); next(); });
SurveySchema.methods.hasUserBid = function (userId) {
  return this.bids.some(bid => bid.userId.toString() === userId.toString());
};
SurveySchema.methods.getUserBid = function (userId) {
  return this.bids.find(bid => bid.userId.toString() === userId.toString());
};

module.exports = mongoose.model('Survey', SurveySchema);
