const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  username: {
    type: String, required: true, unique: true,
    trim: true, minlength: 3, maxlength: 50
  },
  email: {
    type: String, required: true, unique: true,
    lowercase: true, trim: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
  },
  phone: {
    type: String, required: true, unique: true,
    trim: true, minlength: 9
  },
  password: { type: String, required: true, minlength: 6 },

  // Referral Info
  referrerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  uniqueInviteCode: { type: String, unique: true, required: true },
  inviteLink: { type: String, unique: true, required: true },
  registrationInviteCode: { type: String, default: null },

  // Package Info
  packageType: {
    type: String,
    enum: ['not_active', 'normal'],
    default: 'not_active'
  },
  packageActivatedAt: { type: Date, default: null },
  activatedAt: { type: Date, default: null },
  hasActivated: { type: Boolean, default: false },

  // Active Referrals (activated users directly referred)
  activeReferrals: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  // Main Wallet (KES) — earned from referral commissions only
  primaryWallet: {
    balance: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'KES' },
    locked: { type: Boolean, default: false }
  },

  // Points Wallet — earned from tasks (100 pts = KES 10, paid from profit pool on Thursdays)
  pointsWallet: {
    points: { type: Number, default: 0, min: 0 },
    totalEarned: { type: Number, default: 0 },
    // Track new referrals since last points withdrawal (need 4 to withdraw)
    referralsSinceLastWithdrawal: { type: Number, default: 0 },
    lastWithdrawalAt: { type: Date, default: null }
  },

  // Status
  status: {
    type: String,
    enum: ['pending', 'active', 'suspended'],
    default: 'pending'
  },

  isAdmin: { type: Boolean, default: false },

  stats: {
    totalReferrals: { type: Number, default: 0 },
    totalEarnings: { type: Number, default: 0 },
    blogsWritten: { type: Number, default: 0 },
    surveysCompleted: { type: Number, default: 0 },
    activeDirectReferrals: { type: Number, default: 0 }
  },

  // Daily task tracking
  dailyTasks: {
    date: { type: String, default: null },
    blogsCompleted: { type: Number, default: 0 },
    surveysCompleted: { type: Number, default: 0 }
  },

  // Security
  lastLogin: { type: Date, default: null },
  loginAttempts: { type: Number, default: 0 },
  lockUntil: { type: Date, default: null },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Hash password before saving
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    this.updatedAt = Date.now();
    next();
  } catch (error) {
    next(error);
  }
});

UserSchema.methods.comparePassword = async function (inputPassword) {
  return await bcrypt.compare(inputPassword, this.password);
};

UserSchema.methods.isLocked = function () {
  return !!(this.lockUntil && this.lockUntil > Date.now());
};

UserSchema.methods.incLoginAttempts = async function () {
  if (this.lockUntil && this.lockUntil < Date.now()) {
    return await this.updateOne({ $set: { loginAttempts: 1 }, $unset: { lockUntil: 1 } });
  }
  const updates = { $inc: { loginAttempts: 1 } };
  if (this.loginAttempts + 1 >= 5 && !this.isLocked()) {
    updates.$set = { lockUntil: Date.now() + 30 * 60 * 1000 };
  }
  return await this.updateOne(updates);
};

// Check if user can withdraw points:
// needs min 2000 pts AND 4 new referrals since last points withdrawal
UserSchema.methods.canWithdrawPoints = function () {
  return (
    this.pointsWallet.referralsSinceLastWithdrawal >= 4 &&
    this.pointsWallet.points >= 2000
  );
};

// Check if new day for daily tasks
UserSchema.methods.resetDailyTasksIfNeeded = function () {
  const today = new Date().toISOString().slice(0, 10);
  if (this.dailyTasks.date !== today) {
    this.dailyTasks.date = today;
    this.dailyTasks.blogsCompleted = 0;
    this.dailyTasks.surveysCompleted = 0;
  }
};

module.exports = mongoose.model('User', UserSchema);