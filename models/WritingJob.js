const mongoose = require('mongoose');

const WritingJobSchema = new mongoose.Schema({
  title:        { type: String, required: true, trim: true, maxlength: 200 },
  description:  { type: String, required: true, maxlength: 1000 },
  instructions: { type: String, required: true }, // full writing brief
  wordCount:    { type: String, default: null },   // e.g. "500-800 words"
  format:       { type: String, default: null },   // e.g. "Article, Essay, Story"
  reward:       { type: Number, default: 100 },    // points on approval
  maxWorkers:   { type: Number, default: 50 },
  status: {
    type: String,
    enum: ['open','completed','cancelled'],
    default: 'open'
  },
  postedAt:  { type: Date, default: Date.now },
  deadline:  { type: Date, default: null },

  submissions: [{
    userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: {
      type: String,
      enum: ['submitted','approved','rejected'],
      default: 'submitted'
    },
    // Uploaded file details (PDF or DOCX via Cloudinary)
    fileUrl:       { type: String, required: true },   // Cloudinary URL
    filePublicId:  { type: String, required: true },   // for deletion
    fileName:      { type: String, default: null },    // original file name
    fileType:      { type: String, default: null },    // pdf or docx
    submittedAt:   { type: Date, default: Date.now },
    reviewedAt:    { type: Date, default: null },
    reviewNotes:   { type: String, default: null },
    earnedPoints:  { type: Number, default: 0 }
  }],

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

WritingJobSchema.pre('save', function(next){ this.updatedAt = Date.now(); next(); });

WritingJobSchema.methods.hasUserSubmitted = function(userId) {
  return this.submissions.some(s => s.userId.toString() === userId.toString());
};
WritingJobSchema.methods.getUserSubmission = function(userId) {
  return this.submissions.find(s => s.userId.toString() === userId.toString());
};

module.exports = mongoose.model('WritingJob', WritingJobSchema);