const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose'); // Added for Transactions
const { v4: uuidv4 } = require('uuid');
const User = require('../models/Users');
const connectDB = require('../config/db'); 
const { distributeReferralCommissions } = require('../utils/commissionHelper');
const { authMiddleware } = require('../middleware/auth');
const { validateSignup } = require('../middleware/validation');

const router = express.Router();

// Helper to generate JWT
function generateToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

// ==================== SIGNUP ====================
router.post('/signup', validateSignup, async (req, res) => {
  try {
    await connectDB();
    const { username, email, phone, password, referrerCode } = req.body;

    if (!referrerCode || !referrerCode.trim()) {
      return res.status(400).json({ error: 'Referral code is required.' });
    }

    const referrer = await User.findOne({ uniqueInviteCode: referrerCode.trim() });
    if (!referrer) {
      return res.status(400).json({ error: 'Invalid referral code.' });
    }

    const [existingEmail, existingUsername, existingPhone] = await Promise.all([
      User.findOne({ email: email.toLowerCase().trim() }),
      User.findOne({ username: username.trim() }),
      User.findOne({ phone: phone.trim() })
    ]);

    if (existingEmail) return res.status(400).json({ error: 'Email already registered' });
    if (existingUsername) return res.status(400).json({ error: 'Username already taken' });
    if (existingPhone) return res.status(400).json({ error: 'Phone number already registered' });

    const inviteCode = uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase();
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const baseUrl = process.env.FRONTEND_URL || (host ? `${protocol}://${host}` : '');
    const inviteLink = `${baseUrl}/#join?ref=${inviteCode}`;

    const user = new User({
      username: username.trim(),
      email: email.toLowerCase().trim(),
      phone: phone.trim(),
      password,
      referrerId: referrer._id,
      registrationInviteCode: referrerCode.trim(),
      uniqueInviteCode: inviteCode,
      inviteLink,
      packageType: 'not_active',
      status: 'pending'
    });

    await user.save();
    const token = generateToken(user._id);

    res.status(201).json({
      message: 'Account created successfully.',
      token,
      user: { id: user._id, username: user.username, packageType: user.packageType }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== LOGIN ====================
router.post('/login', async (req, res) => {
  try {
    await connectDB();
    const { email, password } = req.body;
    const user = await User.findOne({ email: email.toLowerCase().trim() });

    if (!user || !(await user.comparePassword(password))) {
      if (user) await user.incLoginAttempts();
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    user.loginAttempts = 0;
    user.lastLogin = new Date();
    await user.save();

    const token = generateToken(user._id);
    res.json({ message: 'Login successful', token, user });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== ACTIVATE PACKAGE (WITH FULL ROLLBACK) ====================
router.post('/activate-package', authMiddleware, async (req, res) => {
  await connectDB();
  
  // 1. Start the Session
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // 2. Fetch User within this session
    const user = await User.findById(req.userId).session(session);

    if (!user) throw new Error('User not found');
    if (user.hasActivated) throw new Error('Package already activated.');

    const ACTIVATION_FEE = 700;
    if (user.primaryWallet.balance < ACTIVATION_FEE) {
      throw new Error(`Insufficient balance. KES ${ACTIVATION_FEE} required.`);
    }

    // 3. Deduct money and change status (State is "Pending" in DB)
    user.primaryWallet.balance -= ACTIVATION_FEE;
    user.packageType = 'normal';
    user.status = 'active';
    user.hasActivated = true;
    user.activatedAt = new Date();
    await user.save({ session });

    // 4. Distribute Commissions (Pass session to helper)
    // If the helper fails, it throws an error and jumps to the catch block
    await distributeReferralCommissions(user, 'user', session);

    // 5. Update direct referral stats
    if (user.referrerId) {
      await User.findByIdAndUpdate(
        user.referrerId, 
        { $inc: { 'stats.activeDirectReferrals': 1 } },
        { session }
      );
    }

    // 6. SUCCESS: Commit changes to DB permanently
    await session.commitTransaction();
    session.endSession();

    res.json({
      message: '✅ Package activated and commissions paid.',
      balance: user.primaryWallet.balance
    });

  } catch (error) {
    // 7. FAILURE: Rollback (Undo everything)
    // User gets their 700 KES back instantly
    await session.abortTransaction();
    session.endSession();

    console.error('❌ ACTIVATION FAILED - ROLLBACK EXECUTED:', error.message);
    res.status(400).json({ error: `Activation failed: ${error.message}. Balance restored.` });
  }
});

module.exports = router;
