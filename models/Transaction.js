const mongoose = require('mongoose');

// Every money movement is logged here — gives admin full P&L picture
const TransactionSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: [
      'activation',           // +700 KES revenue (user activates)
      'referral_commission',  // -KES cost (commission paid out)
      'kes_withdrawal',       // -KES cost (wallet withdrawal paid)
      'points_withdrawal',    // -KES cost (points redeemed, paid out)
      'deposit',              // +KES (manual admin deposit to user)
      'refund'                // +KES (withdrawal rejected, refunded)
    ],
    required: true
  },
  direction: { type: String, enum: ['in','out'], required: true }, // in=revenue, out=cost
  amount:    { type: Number, required: true, min: 0 },  // always in KES
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  username:  { type: String, default: null }, // denormalized for fast queries
  description: { type: String, default: '' },
  referenceId: { type: String, default: null }, // withdrawal ref, commission id etc
  createdAt: { type: Date, default: Date.now }
});

TransactionSchema.index({ type: 1, createdAt: -1 });
TransactionSchema.index({ createdAt: -1 });
TransactionSchema.index({ direction: 1, createdAt: -1 });

module.exports = mongoose.model('Transaction', TransactionSchema);