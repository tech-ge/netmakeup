const mongoose = require('mongoose');

const WithdrawalSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // 'kes' = from primaryWallet (Tuesdays), 'points' = points converted to KES paid from profit pool (Thursdays)
  type: { type: String, enum: ['kes', 'points'], default: 'kes' },

  amount: { type: Number, required: true, min: 0 },

  // For points withdrawals: how many points were redeemed
  pointsRedeemed: { type: Number, default: 0 },

  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'completed', 'failed'],
    default: 'pending'
  },
  paymentMethod: { type: String, enum: ['mpesa', 'bank'], default: 'mpesa' },
  paymentDetails: {
    mpesaPhone: { type: String },
    bankName: { type: String },
    accountNumber: { type: String },
    accountName: { type: String }
  },
  requestedAt: { type: Date, default: Date.now },
  processedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  adminNotes: { type: String, default: null },
  transactionReference: { type: String, unique: true, sparse: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

WithdrawalSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

WithdrawalSchema.pre('save', async function (next) {
  if (!this.transactionReference) {
    const d = new Date();
    const prefix = this.type === 'points' ? 'PTS' : 'WDR';
    const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    this.transactionReference = `${prefix}-${d.getFullYear().toString().slice(-2)}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}-${rand}`;
  }
  next();
});

module.exports = mongoose.model('Withdrawal', WithdrawalSchema);