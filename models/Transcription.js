const mongoose = require('mongoose');

const TranscriptionSchema = new mongoose.Schema({
  title:       { type: String, required: true, trim: true, maxlength: 200 },
  description: { type: String, required: true, maxlength: 1000 },
  instructions:{ type: String, required: true }, // what to transcribe, format rules etc
  audioUrl:    { type: String, required: true },  // Cloudinary URL
  audioPublicId: { type: String, required: true },// Cloudinary public_id for deletion
  audioDuration: { type: Number, default: null }, // seconds, optional
  reward:      { type: Number, default: 50 },     // points awarded on approval
  maxWorkers:  { type: Number, default: 50 },     // max people who can do this job
  status: {
    type: String,
    enum: ['open','completed','cancelled'],
    default: 'open'
  },
  postedAt:  { type: Date, default: Date.now },
  deadline:  { type: Date, default: null },

  submissions: [{
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status:    {
      type: String,
      enum: ['submitted','approved','rejected'],
      default: 'submitted'
    },
    content:       { type: String, required: true }, // typed transcription text
    submittedAt:   { type: Date, default: Date.now },
    reviewedAt:    { type: Date, default: null },
    reviewNotes:   { type: String, default: null },
    earnedPoints:  { type: Number, default: 0 }
  }],

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

TranscriptionSchema.pre('save', function(next){ this.updatedAt = Date.now(); next(); });

TranscriptionSchema.methods.hasUserSubmitted = function(userId) {
  return this.submissions.some(s => s.userId.toString() === userId.toString());
};
TranscriptionSchema.methods.getUserSubmission = function(userId) {
  return this.submissions.find(s => s.userId.toString() === userId.toString());
};

module.exports = mongoose.model('Transcription', TranscriptionSchema);