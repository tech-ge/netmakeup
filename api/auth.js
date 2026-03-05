const express  = require('express');
const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const User     = require('../models/Users');
const { validateSignup }               = require('../middleware/validation');
const { authMiddleware }               = require('../middleware/auth');
const { distributeReferralCommissions, ACTIVATION_FEE } = require('../utils/commissionHelper');

const router = express.Router();

function generateToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function userPayload(user) {
  return {
    id:           user._id,
    username:     user.username,
    email:        user.email,
    phone:        user.phone,
    status:       user.status,
    packageType:  user.packageType,
    hasActivated: user.hasActivated,
    isAdmin:      user.isAdmin,
    inviteCode:   user.uniqueInviteCode,
    inviteLink:   user.inviteLink,
    primaryWallet: user.primaryWallet,
    pointsWallet: {
      points:      user.pointsWallet.points,
      totalEarned: user.pointsWallet.totalEarned
    },
    stats: user.stats
  };
}

// ==================== REGISTER ====================
router.post('/signup', validateSignup, async (req, res) => {
  try {
    const { username, email, phone, password, referrerCode } = req.body;

    const referrer = await User.findOne({ uniqueInviteCode: referrerCode.trim() });
    if (!referrer) {
      return res.status(400).json({ error: 'Invalid referral code. Please check with your referrer.' });
    }

    const [existingEmail, existingPhone, existingUsername] = await Promise.all([
      User.findOne({ email: email.toLowerCase().trim() }),
      User.findOne({ phone: phone.trim() }),
      User.findOne({ username: username.trim() })
    ]);
    if (existingEmail)    return res.status(400).json({ error: 'Email already registered.' });
    if (existingPhone)    return res.status(400).json({ error: 'Phone number already registered.' });
    if (existingUsername) return res.status(400).json({ error: 'Username already taken.' });

    const inviteCode = uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase();
    const protocol   = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host       = req.headers['x-forwarded-host'] || req.headers.host || '';
    const baseUrl    = process.env.FRONTEND_URL || (host ? `${protocol}://${host}` : '');
    const inviteLink = `${baseUrl}/#join?ref=${inviteCode}`;

    const user = new User({
      username:              username.trim(),
      email:                 email.toLowerCase().trim(),
      phone:                 phone.trim(),
      password,
      referrerId:            referrer._id,
      registrationInviteCode: referrerCode.trim(),
      uniqueInviteCode:      inviteCode,
      inviteLink,
      status:                'pending',
      packageType:           'not_active'
    });

    await user.save();
    const token = generateToken(user._id);

    console.log(`✅ NEW SIGNUP: ${user.username} referred by ${referrer.username}`);
    res.status(201).json({
      message: 'Account created! Please activate your package to start earning.',
      token,
      user: userPayload(user)
    });
  } catch (error) {
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(400).json({ error: `${field} already exists.` });
    }
    res.status(500).json({ error: error.message });
  }
});

// ==================== LOGIN ====================
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });

    if (user.isLocked()) {
      return res.status(403).json({
        error: 'Account temporarily locked due to too many failed attempts. Try again in 30 minutes.'
      });
    }
    if (user.status === 'suspended') {
      return res.status(403).json({ error: 'Account suspended. Contact support.' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      await user.incLoginAttempts();
      const attemptsLeft = Math.max(0, 4 - user.loginAttempts);
      return res.status(401).json({
        error: `Invalid email or password.${attemptsLeft > 0 ? ` ${attemptsLeft} attempt(s) remaining before lockout.` : ''}`
      });
    }

    await user.updateOne({
      $set:   { loginAttempts: 0, lastLogin: new Date() },
      $unset: { lockUntil: 1 }
    });

    const freshUser = await User.findById(user._id);
    const token = generateToken(freshUser._id);
    console.log(`🔐 LOGIN: ${freshUser.username}`);
    res.json({ message: 'Login successful.', token, user: userPayload(freshUser) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ACTIVATE PACKAGE ====================
// Flow: admin deposits KES 700 into user wallet → user clicks activate →
//       KES 700 deducted → commissions paid up 4 levels → user goes active.
//       Everything runs in ONE Mongoose session — any failure rolls back ALL changes.
router.post('/activate-package', authMiddleware, async (req, res) => {
  // Vercel serverless: create a fresh session per request
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const user = await User.findById(req.userId).session(session);
    if (!user) {
      await session.abortTransaction();
      return res.status(404).json({ error: 'User not found.' });
    }
    if (user.packageType === 'normal') {
      await session.abortTransaction();
      return res.status(400).json({ error: 'Package already activated.' });
    }
    if (user.primaryWallet.balance < ACTIVATION_FEE) {
      await session.abortTransaction();
      return res.status(400).json({
        error: `Insufficient balance. You need KES ${ACTIVATION_FEE} to activate. Current balance: KES ${user.primaryWallet.balance}.`,
        required: ACTIVATION_FEE,
        current:  user.primaryWallet.balance
      });
    }

    // 1. Deduct fee & activate user
    user.primaryWallet.balance -= ACTIVATION_FEE;
    user.packageType            = 'normal';
    user.status                 = 'active';
    user.hasActivated           = true;
    user.activatedAt            = new Date();
    user.packageActivatedAt     = new Date();
    await user.save({ session });

    // 2. Update direct referrer's stats (within session → rolls back if needed)
    if (user.referrerId) {
      await User.findByIdAndUpdate(
        user.referrerId,
        {
          $addToSet: { activeReferrals: user._id },
          $inc: {
            'stats.totalReferrals':        1,
            'stats.activeDirectReferrals': 1
          }
        },
        { session }
      );
    }

    // 3. Distribute commissions — throws on any error → triggers rollback below
    await distributeReferralCommissions(user, 'activation', session);

    // 4. All good — commit everything atomically
    await session.commitTransaction();
    console.log(`🎉 ACTIVATION: ${user.username} | KES ${ACTIVATION_FEE} deducted | commissions paid`);

    const freshUser = await User.findById(user._id);
    const token = generateToken(freshUser._id);

    res.json({
      message: '🎉 Package activated! Welcome to TechGeo Network. Start earning now.',
      token,
      user: userPayload(freshUser)
    });
  } catch (error) {
    // ← Any failure above (including commission errors) rolls back ALL wallet changes
    try { await session.abortTransaction(); } catch (_) {}
    console.error('❌ Activation rollback triggered:', error.message);
    res.status(500).json({
      error: 'Activation failed and all changes were rolled back. Please try again.',
      detail: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    session.endSession();
  }
});

// ==================== GET CURRENT USER ====================
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ user: userPayload(user) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
