const express = require('express');
const jwt     = require('jsonwebtoken');
const User    = require('../models/Users');
const { authMiddleware } = require('../middleware/auth');
const { sendOTP }        = require('../utils/emailHelper');

const router = express.Router();

// ── Generate a 6-digit OTP ────────────────────────────────────────────────────
function makeOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ── Save OTP to user document ─────────────────────────────────────────────────
async function setOTP(userId, reason) {
  const otp = makeOTP();
  await User.findByIdAndUpdate(userId, {
    'otp.code':      otp,
    'otp.expiresAt': new Date(Date.now() + 10 * 60 * 1000), // 10 min
    'otp.reason':    reason,
  });
  return otp;
}

// ── Verify OTP (shared logic) ─────────────────────────────────────────────────
async function verifyOTP(user, code, expectedReason) {
  if (!user.otp?.code)              return 'No OTP was requested. Please request a new code.';
  if (user.otp.code !== code)       return 'Incorrect OTP code. Please check your email and try again.';
  if (new Date() > user.otp.expiresAt) return 'This OTP has expired. Please request a new one.';
  if (user.otp.reason !== expectedReason) return 'Invalid OTP for this action.';
  return null; // null = valid
}

// ══════════════════════════════════════════════════════════════════
// STEP 1 — REGISTER: collect details, send OTP to email
// POST /api/auth/signup
// ══════════════════════════════════════════════════════════════════
router.post('/signup', async (req, res) => {
  try {
    const { username, email, phone, password, inviteCode } = req.body;

    if (!username || !email || !phone || !password)
      return res.status(400).json({ error: 'All fields are required.' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    // Check duplicates
    const exists = await User.findOne({ $or: [
      { email: email.toLowerCase().trim() },
      { username: username.trim() },
      { phone: phone.trim() }
    ]});
    if (exists) {
      if (exists.email === email.toLowerCase().trim())
        return res.status(400).json({ error: 'Email already registered.' });
      if (exists.username === username.trim())
        return res.status(400).json({ error: 'Username already taken.' });
      return res.status(400).json({ error: 'Phone number already registered.' });
    }

    // Find referrer
    let referrer = null;
    if (inviteCode) {
      referrer = await User.findOne({ uniqueInviteCode: inviteCode.trim().toUpperCase() });
      if (!referrer) return res.status(400).json({ error: 'Invalid invite code.' });
    }

    // Generate unique invite code and link for new user
    const userInviteCode = username.trim().toUpperCase().slice(0, 6) + Math.random().toString(36).slice(2, 5).toUpperCase();
    const baseUrl = process.env.FRONTEND_URL || 'https://techgeo.co.ke';

    // Create user (unverified)
    const user = await User.create({
      username:               username.trim(),
      email:                  email.toLowerCase().trim(),
      phone:                  phone.trim(),
      password,
      referrerId:             referrer?._id || null,
      registrationInviteCode: inviteCode?.trim().toUpperCase() || null,
      uniqueInviteCode:       userInviteCode,
      inviteLink:             `${baseUrl}/?ref=${userInviteCode}`,
      emailVerified:          false,
      status:                 'pending',
    });

    // Send OTP
    const otp = await setOTP(user._id, 'register');
    await sendOTP(user.email, user.username, otp, 'register');

    res.status(201).json({
      message: 'Account created! Check your email for a 6-digit verification code.',
      userId:  user._id,
      step:    'verify_email',
    });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'Username, email or phone already exists.' });
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// STEP 2 — VERIFY EMAIL OTP after registration
// POST /api/auth/verify-email
// ══════════════════════════════════════════════════════════════════
router.post('/verify-email', async (req, res) => {
  try {
    const { userId, otp } = req.body;
    if (!userId || !otp) return res.status(400).json({ error: 'userId and otp required.' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.emailVerified) return res.status(400).json({ error: 'Email already verified. Please log in.' });

    const err = await verifyOTP(user, otp.trim(), 'register');
    if (err) return res.status(400).json({ error: err });

    // Mark verified, clear OTP
    await User.findByIdAndUpdate(userId, {
      emailVerified: true,
      status:        'pending', // stays pending until they activate (pay KES 700)
      $unset:        { otp: 1 },
    });

    // Issue a login token so they land on dashboard immediately
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: 'Email verified! Welcome to TechGeo Network.',
      token,
      user: {
        id:          user._id,
        username:    user.username,
        email:       user.email,
        packageType: user.packageType,
        isAdmin:     user.isAdmin,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// RESEND OTP (register only — no auth required yet)
// POST /api/auth/resend-otp
// ══════════════════════════════════════════════════════════════════
router.post('/resend-otp', async (req, res) => {
  try {
    const { userId } = req.body;
    const user = await User.findById(userId);
    if (!user)              return res.status(404).json({ error: 'User not found.' });
    if (user.emailVerified) return res.status(400).json({ error: 'Email already verified.' });

    const otp = await setOTP(user._id, 'register');
    await sendOTP(user.email, user.username, otp, 'register');
    res.json({ message: 'A new OTP has been sent to your email.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// LOGIN
// POST /api/auth/login
// ══════════════════════════════════════════════════════════════════
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });

    if (user.isLocked?.()) {
      const mins = Math.ceil((user.lockUntil - Date.now()) / 60000);
      return res.status(403).json({ error: `Account locked. Try again in ${mins} minute(s).` });
    }

    const match = await user.comparePassword(password);
    if (!match) {
      await user.incLoginAttempts();
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (user.status === 'suspended')
      return res.status(403).json({ error: 'Account suspended. Contact support.' });

    // Reset failed attempts, update lastLogin
    await User.findByIdAndUpdate(user._id, {
      loginAttempts: 0,
      $unset: { lockUntil: 1 },
      lastLogin: new Date(),
    });

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: 'Login successful.',
      token,
      user: {
        id:          user._id,
        username:    user.username,
        email:       user.email,
        packageType: user.packageType,
        isAdmin:     user.isAdmin,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// CHANGE PASSWORD — requires current password + OTP to confirm
// Step 1: POST /api/auth/change-password/request  → sends OTP
// Step 2: POST /api/auth/change-password/confirm  → verifies OTP + saves new password
// ══════════════════════════════════════════════════════════════════
router.post('/change-password/request', authMiddleware, async (req, res) => {
  try {
    const { currentPassword } = req.body;
    if (!currentPassword) return res.status(400).json({ error: 'Current password is required.' });

    const user = await User.findById(req.userId);
    const match = await user.comparePassword(currentPassword);
    if (!match) return res.status(401).json({ error: 'Current password is incorrect.' });

    const otp = await setOTP(user._id, 'change_password');
    await sendOTP(user.email, user.username, otp, 'change_password');

    res.json({ message: 'OTP sent to your email. Enter it to confirm your password change.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/change-password/confirm', authMiddleware, async (req, res) => {
  try {
    const { otp, newPassword } = req.body;
    if (!otp || !newPassword)   return res.status(400).json({ error: 'OTP and new password required.' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const user = await User.findById(req.userId);
    const err  = await verifyOTP(user, otp.trim(), 'change_password');
    if (err) return res.status(400).json({ error: err });

    const same = await user.comparePassword(newPassword);
    if (same) return res.status(400).json({ error: 'New password must be different from current password.' });

    user.password = newPassword; // pre-save hook will hash it
    user.otp      = undefined;
    await user.save();

    res.json({ message: 'Password changed successfully. Please log in again.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// FORGOT PASSWORD (not logged in)
// Step 1: POST /api/auth/forgot-password/request  → sends OTP to email
// Step 2: POST /api/auth/forgot-password/confirm  → verifies OTP + resets password
// ══════════════════════════════════════════════════════════════════
router.post('/forgot-password/request', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    // Always respond OK — never reveal if email exists (security best practice)
    if (!user) return res.json({ message: 'If that email exists, an OTP has been sent.' });

    const otp = await setOTP(user._id, 'forgot_password');
    await sendOTP(user.email, user.username, otp, 'forgot_password');

    res.json({
      message: 'OTP sent to your email. Enter it below to reset your password.',
      userId:  user._id, // needed for confirm step
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/forgot-password/confirm', async (req, res) => {
  try {
    const { userId, otp, newPassword } = req.body;
    if (!userId || !otp || !newPassword)
      return res.status(400).json({ error: 'userId, otp and newPassword are required.' });
    if (newPassword.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const err = await verifyOTP(user, otp.trim(), 'forgot_password');
    if (err) return res.status(400).json({ error: err });

    user.password = newPassword; // pre-save hook hashes it
    user.otp      = undefined;
    await user.save();

    res.json({ message: 'Password reset successful. You can now log in with your new password.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
