const mongoose = require('mongoose');

const BlogSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, required: true, maxlength: 1000 },
  content: { type: String, required: true },
  category: { type: String, default: 'general' },
  reward: { type: Number, default: 100 }, // 100 points per approved blog
  postedBy: { type: String, default: 'admin' },
  postedAt: { type: Date, default: Date.now },
  deadline: { type: Date, default: null },
  maxBidders: { type: Number, default: 50 },
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
    submissionContent: { type: String, default: null },
    submittedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    reviewNotes: { type: String, default: null },
    earnedPoints: { type: Number, default: 100 }
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

BlogSchema.pre('save', function (next) { this.updatedAt = Date.now(); next(); });
BlogSchema.methods.hasUserBid = function (userId) {
  return this.bids.some(bid => bid.userId.toString() === userId.toString());
};
BlogSchema.methods.getUserBid = function (userId) {
  return this.bids.find(bid => bid.userId.toString() === userId.toString());
};

module.exports = mongoose.model('Blog', BlogSchema);
