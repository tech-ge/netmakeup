const express    = require('express');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const mongoose   = require('mongoose');
const User       = require('../models/Users');
const { validateSignup }  = require('../middleware/validation');
const { authMiddleware }  = require('../middleware/auth');
const { distributeReferralCommissions, ACTIVATION_FEE } = require('../utils/commissionHelper');
const { sendOTP } = require('../utils/emailHelper');

const router = express.Router();

// ── Constants ─────────────────────────────────────────────────────────────────
const OTP_EXPIRY_MS    = 10 * 60 * 1000;   // 10 minutes
const OTP_MAX_REQUESTS = 3;                  // max resends before snooze
const OTP_SNOOZE_MS    = 60 * 60 * 1000;   // 1 hour snooze after 3 attempts

// ── Helpers ───────────────────────────────────────────────────────────────────
function generateOTP()  { return Math.floor(100000 + Math.random() * 900000).toString(); }
function generateToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '30d' });
}
function generateInviteCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

// ── Shared OTP sender with rate-limit + snooze logic ─────────────────────────
// reason: 'register' | 'forgot_password'
// Returns { ok, error, snoozedUntil } 
async function issueOTP(user, reason) {
  const now = Date.now();

  // Check snooze (applies across both reasons separately — track by reason in requestCount)
  if (user.otp?.snoozedUntil && user.otp.reason === reason) {
    const snoozedUntil = new Date(user.otp.snoozedUntil);
    if (now < snoozedUntil.getTime()) {
      const minsLeft = Math.ceil((snoozedUntil.getTime() - now) / 60000);
      return {
        ok: false,
        snoozedUntil,
        error: `Too many attempts. Please wait ${minsLeft} minute${minsLeft !== 1 ? 's' : ''} before requesting a new code.`
      };
    }
    // Snooze expired — reset counter
    user.otp.requestCount = 0;
    user.otp.snoozedUntil = null;
  }

  // Reset counter if reason changed (switching from register to forgot is fine)
  if (user.otp?.reason && user.otp.reason !== reason) {
    user.otp.requestCount = 0;
    user.otp.snoozedUntil = null;
  }

  const currentCount = (user.otp?.requestCount || 0);

  // Enforce max 3 requests
  if (currentCount >= OTP_MAX_REQUESTS) {
    const snoozedUntil = new Date(now + OTP_SNOOZE_MS);
    user.otp.snoozedUntil = snoozedUntil;
    await user.save();
    return {
      ok: false,
      snoozedUntil,
      error: `Maximum attempts reached. Your account is paused for 1 hour. Try again after ${snoozedUntil.toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi' })}.`
    };
  }

  // Issue new OTP
  const otp = generateOTP();
  user.otp = {
    code:         otp,
    expiresAt:    new Date(now + OTP_EXPIRY_MS),
    reason,
    requestCount: currentCount + 1,
    snoozedUntil: null
  };
  await user.save();

  // Send email (non-blocking — never crash the response)
  sendOTP(user.email, user.username, otp, reason).catch(err => {
    console.error(`OTP email failed [${reason}] for ${user.email}:`, err.message);
  });

  const attemptsLeft = OTP_MAX_REQUESTS - (currentCount + 1);
  return { ok: true, attemptsLeft };
}

// ── POST /api/auth/signup ─────────────────────────────────────────────────────
router.post('/signup', validateSignup, async (req, res) => {
  try {
    const { username, email, phone, password, inviteCode } = req.body;

    const referrer = await User.findOne({ uniqueInviteCode: inviteCode.trim().toUpperCase() });
    if (!referrer) return res.status(400).json({ error: 'Invalid referral code. Please check and try again.' });

    const [existEmail, existPhone, existUsername] = await Promise.all([
      User.findOne({ email: email.toLowerCase().trim() }),
      User.findOne({ phone: phone.trim() }),
      User.findOne({ username: username.trim() })
    ]);
    if (existEmail)    return res.status(400).json({ error: 'An account with this email already exists.' });
    if (existPhone)    return res.status(400).json({ error: 'An account with this phone number already exists.' });
    if (existUsername) return res.status(400).json({ error: 'This username is taken. Please choose another.' });

    // Unique invite code for new user
    let newCode, taken = true;
    while (taken) { newCode = generateInviteCode(); taken = await User.findOne({ uniqueInviteCode: newCode }); }

    const baseUrl    = process.env.FRONTEND_URL || 'https://techgeo.co.ke';
    const inviteLink = `${baseUrl}/#join?ref=${newCode}`;

    const user = new User({
      username:    username.trim(),
      email:       email.toLowerCase().trim(),
      phone:       phone.trim(),
      password,
      referrerId:  referrer._id,
      uniqueInviteCode: newCode,
      inviteLink,
      registrationInviteCode: inviteCode.trim().toUpperCase(),
      status:        'pending',
      packageType:   'not_active',
      emailVerified: false,
      otp: { code: null, expiresAt: null, reason: null, requestCount: 0, snoozedUntil: null }
    });
    await user.save();

    // Auto-send OTP immediately on signup (counts as attempt 1 of 3)
    const result = await issueOTP(user, 'register');
    if (!result.ok) {
      // Extremely unlikely on brand-new account but handle gracefully
      return res.status(429).json({ error: result.error });
    }

    res.status(201).json({
      message: 'Account created. A 6-digit verification code has been sent to your email. It expires in 10 minutes.',
      userId: user._id,
      attemptsLeft: result.attemptsLeft
    });
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/verify-email ───────────────────────────────────────────────
router.post('/verify-email', async (req, res) => {
  try {
    const { userId, otp } = req.body;
    if (!userId || !otp) return res.status(400).json({ error: 'userId and OTP are required.' });

    const user = await User.findById(userId);
    if (!user)             return res.status(404).json({ error: 'User not found.' });
    if (user.emailVerified) return res.status(400).json({ error: 'Email already verified.' });

    if (!user.otp?.code || user.otp.reason !== 'register') {
      return res.status(400).json({ error: 'No verification code found. Please request a new one.' });
    }
    if (new Date() > new Date(user.otp.expiresAt)) {
      return res.status(400).json({ error: 'Code has expired. Please request a new one.' });
    }
    if (user.otp.code !== otp.trim()) {
      return res.status(400).json({ error: 'Incorrect code. Please try again.' });
    }

    // Verified — activate
    user.emailVerified = true;
    user.status        = 'active';
    user.otp           = { code: null, expiresAt: null, reason: null, requestCount: 0, snoozedUntil: null };
    user.lastLogin     = new Date();
    await user.save();

    await User.findByIdAndUpdate(user.referrerId, { $inc: { 'stats.totalReferrals': 1 } });

    const token = generateToken(user._id);
    res.json({
      message: '✅ Email verified! Welcome to TechGeo Network.',
      token,
      user: {
        id: user._id, username: user.username, email: user.email,
        phone: user.phone, status: user.status, packageType: user.packageType,
        hasActivated: user.hasActivated, isAdmin: user.isAdmin,
        primaryWallet: user.primaryWallet, pointsWallet: user.pointsWallet,
        inviteCode: user.uniqueInviteCode, inviteLink: user.inviteLink
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/resend-otp  (register only) ────────────────────────────────
router.post('/resend-otp', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required.' });

    const user = await User.findById(userId);
    if (!user)              return res.status(404).json({ error: 'User not found.' });
    if (user.emailVerified) return res.status(400).json({ error: 'Email already verified.' });

    const result = await issueOTP(user, 'register');
    if (!result.ok) return res.status(429).json({ error: result.error, snoozedUntil: result.snoozedUntil });

    res.json({
      message: `New code sent to your email. It expires in 10 minutes.`,
      attemptsLeft: result.attemptsLeft
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });

    if (user.isLocked && user.isLocked()) {
      return res.status(403).json({ error: 'Account locked due to too many failed attempts. Try again in 30 minutes.' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      await user.incLoginAttempts();
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (user.status === 'suspended') {
      return res.status(403).json({ error: 'Your account has been suspended. Contact support.' });
    }

    // Not verified — resend OTP and ask to verify
    if (!user.emailVerified) {
      const result = await issueOTP(user, 'register');
      return res.status(403).json({
        error: result.ok
          ? 'Email not verified. A new verification code has been sent to your email.'
          : result.error,
        requiresVerification: true,
        userId: user._id,
        snoozedUntil: result.snoozedUntil || null
      });
    }

    if (user.loginAttempts > 0) { user.loginAttempts = 0; user.lockUntil = null; }
    user.lastLogin = new Date();
    await user.save();

    res.json({
      message: 'Login successful.',
      token: generateToken(user._id),
      user: {
        id: user._id, username: user.username, email: user.email,
        phone: user.phone, status: user.status, packageType: user.packageType,
        hasActivated: user.hasActivated, isAdmin: user.isAdmin,
        primaryWallet: user.primaryWallet, pointsWallet: user.pointsWallet,
        inviteCode: user.uniqueInviteCode, inviteLink: user.inviteLink
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/forgot-password/request ────────────────────────────────────
router.post('/forgot-password/request', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      // Don't reveal whether email exists
      return res.json({ message: 'If that email is registered, a reset code has been sent.', userId: null });
    }

    const result = await issueOTP(user, 'forgot_password');
    if (!result.ok) {
      return res.status(429).json({ error: result.error, snoozedUntil: result.snoozedUntil });
    }

    res.json({
      message: 'A 6-digit reset code has been sent to your email. It expires in 10 minutes.',
      userId: user._id,
      attemptsLeft: result.attemptsLeft
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/forgot-password/confirm ────────────────────────────────────
router.post('/forgot-password/confirm', async (req, res) => {
  try {
    const { userId, otp, newPassword } = req.body;
    if (!userId || !otp || !newPassword) {
      return res.status(400).json({ error: 'userId, OTP and new password are required.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (!user.otp?.code || user.otp.reason !== 'forgot_password') {
      return res.status(400).json({ error: 'No reset code found. Please request a new one.' });
    }
    if (new Date() > new Date(user.otp.expiresAt)) {
      return res.status(400).json({ error: 'Reset code has expired. Please request a new one.' });
    }
    if (user.otp.code !== otp.trim()) {
      return res.status(400).json({ error: 'Incorrect reset code. Please try again.' });
    }

    user.password      = newPassword;
    user.otp           = { code: null, expiresAt: null, reason: null, requestCount: 0, snoozedUntil: null };
    user.loginAttempts = 0;
    user.lockUntil     = null;
    await user.save();

    res.json({ message: '✅ Password reset successfully. Please log in.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/auth/activate-package ──────────────────────────────────────────
router.post('/activate-package', authMiddleware, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const user = await User.findById(req.userId).session(session);
    if (!user) { await session.abortTransaction(); return res.status(404).json({ error: 'User not found.' }); }
    if (user.hasActivated) { await session.abortTransaction(); return res.status(400).json({ error: 'Package already activated.' }); }
    if (user.primaryWallet.balance < ACTIVATION_FEE) {
      await session.abortTransaction();
      return res.status(400).json({ error: `Insufficient balance. You need KES ${ACTIVATION_FEE}. Your balance: KES ${user.primaryWallet.balance}.` });
    }

    user.primaryWallet.balance -= ACTIVATION_FEE;
    user.packageType            = 'normal';
    user.hasActivated           = true;
    user.activatedAt            = new Date();
    user.packageActivatedAt     = new Date();
    user.status                 = 'active';
    await user.save({ session });

    if (user.referrerId) {
      await User.findByIdAndUpdate(user.referrerId,
        { $inc: { 'stats.activeDirectReferrals': 1 }, $addToSet: { activeReferrals: user._id } },
        { session }
      );
    }

    await distributeReferralCommissions(user, 'activation', session);
    await session.commitTransaction();

    res.json({ message: '✅ Package activated! You can now earn from all tasks.' });
  } catch (err) {
    await session.abortTransaction();
    res.status(500).json({ error: err.message });
  } finally {
    session.endSession();
  }
});

module.exports = router;
