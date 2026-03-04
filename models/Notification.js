const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type:    {
    type: String,
    enum: ['task_approved','task_rejected','withdrawal_paid','withdrawal_rejected','system'],
    required: true
  },
  title:   { type: String, required: true },
  message: { type: String, required: true },
  isRead:  { type: Boolean, default: false },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }, // taskId, taskType, points etc
  createdAt: { type: Date, default: Date.now }
});

NotificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', NotificationSchema);