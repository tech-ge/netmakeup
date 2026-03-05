const mongoose = require('mongoose');

const DataEntrySchema = new mongoose.Schema({
  title:        { type: String, required: true, trim: true, maxlength: 200 },
  description:  { type: String, required: true, maxlength: 1000 },
  instructions: { type: String, required: true },
  templateUrl:      { type: String, default: null },
  templatePublicId: { type: String, default: null },
  reward:     { type: Number, default: 75 },
  maxWorkers: { type: Number, default: 50 },
  status: {
    type: String,
    enum: ['open', 'completed', 'cancelled'],
    default: 'open'
  },
  postedAt: { type: Date, default: Date.now },
  deadline: { type: Date, default: null },
  submissions: [{
    userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status:      { type: String, enum: ['submitted', 'approved', 'rejected'], default: 'submitted' },
    fileUrl:      { type: String, required: true },
    filePublicId: { type: String, required: true },
    fileName:     { type: String, default: null },
    fileType:     { type: String, default: null },
    submittedAt:  { type: Date, default: Date.now },
    reviewedAt:   { type: Date, default: null },
    reviewNotes:  { type: String, default: null },
    earnedPoints: { type: Number, default: 0 }
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

DataEntrySchema.pre('save', function (next) { this.updatedAt = Date.now(); next(); });
DataEntrySchema.methods.hasUserSubmitted = function (userId) {
  return this.submissions.some(s => s.userId.toString() === userId.toString());
};
DataEntrySchema.methods.getUserSubmission = function (userId) {
  return this.submissions.find(s => s.userId.toString() === userId.toString());
};

module.exports = mongoose.model('DataEntry', DataEntrySchema);
