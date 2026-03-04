const mongoose = require('mongoose');

const CommissionSchema = new mongoose.Schema({
  fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  toUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  level: { type: Number, required: true, min: 1, max: 4 },
  amount: { type: Number, required: true, min: 0 },
  type: {
    type: String,
    enum: [
      'referral_commission',
      'blog_earning',
      'survey_earning',
      'transcription_earning',
      'writing_earning',
      'dataentry_earning',
      'points_conversion',
      'points_withdrawal_payout'  // paid from profit pool, not user wallet
    ],
    default: 'referral_commission'
  },
  status: { type: String, enum: ['completed', 'pending', 'failed'], default: 'completed' },
  description: { type: String, default: '' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now }
});

CommissionSchema.index({ toUserId: 1, createdAt: -1 });
CommissionSchema.index({ fromUserId: 1, createdAt: -1 });
CommissionSchema.index({ type: 1, createdAt: -1 });

module.exports = mongoose.model('Commission', CommissionSchema);