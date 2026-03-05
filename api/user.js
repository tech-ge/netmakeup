const express = require('express');
const User = require('../models/Users');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Get profile
router.get('/profile', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        phone: user.phone,
        status: user.status,
        packageType: user.packageType,
        hasActivated: user.hasActivated,
        inviteCode: user.uniqueInviteCode,
        inviteLink: user.inviteLink,
        primaryWallet: user.primaryWallet,
        pointsWallet: user.pointsWallet,
        stats: user.stats,
        dailyTasks: user.dailyTasks,
        createdAt: user.createdAt,
        lastLogin: user.lastLogin,
        canWithdrawPoints: user.canWithdrawPoints ? user.canWithdrawPoints() : false
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Change password
router.put('/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'New password must be different from current password.' });
    }

    const user = await User.findById(req.userId);
    const isMatch = await user.comparePassword(currentPassword);

    if (!isMatch) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    user.password = newPassword;
    await user.save();

    res.json({ message: '✅ Password changed successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get user dashboard data
router.get('/dashboard', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const today = new Date().toISOString().slice(0, 10);
    const dailyBlogsLeft = user.dailyTasks.date === today ? 2 - user.dailyTasks.blogsCompleted : 2;
    const dailySurveysLeft = user.dailyTasks.date === today ? 2 - user.dailyTasks.surveysCompleted : 2;

    // Direct referrals
    const directReferrals = await User.find({ referrerId: user._id })
      .select('username email phone status packageType createdAt')
      .lean();

    res.json({
      profile: {
        id: user._id, username: user.username, email: user.email,
        phone: user.phone, status: user.status, packageType: user.packageType,
        hasActivated: user.hasActivated, joinedAt: user.createdAt
      },
      wallets: {
        primary: { balance: user.primaryWallet.balance, currency: 'KES' },
        points: {
          points: user.pointsWallet.points,
          totalEarned: user.pointsWallet.totalEarned,
          kesEquivalent: Math.floor(user.pointsWallet.points / 100) * 10,
          canConvert: user.canWithdrawPoints ? user.canWithdrawPoints() : false
        }
      },
      stats: {
        totalReferrals: user.stats.totalReferrals,
        activeDirectReferrals: user.stats.activeDirectReferrals,
        totalEarnings: user.stats.totalEarnings,
        blogsWritten: user.stats.blogsWritten,
        surveysCompleted: user.stats.surveysCompleted
      },
      dailyProgress: {
        date: today,
        blogsLeft: Math.max(0, dailyBlogsLeft),
        surveysLeft: Math.max(0, dailySurveysLeft),
        maxPerDay: 2
      },
      inviteCode: user.uniqueInviteCode,
      inviteLink: user.inviteLink?.includes('undefined') || !user.inviteLink
        ? `${req.headers['x-forwarded-proto'] || req.protocol || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host || ''}/#join?ref=${user.uniqueInviteCode}`
        : user.inviteLink,
      directReferrals: directReferrals.map(r => ({
        id: r._id, username: r.username, email: r.email, phone: r.phone,
        status: r.status, packageType: r.packageType, joinedAt: r.createdAt
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get inactive referrals (visible to parent/father only)
router.get('/inactive-referrals', authMiddleware, async (req, res) => {
  try {
    const inactiveReferrals = await User.find({
      referrerId: req.userId,
      packageType: 'not_active'
    }).select('username email phone createdAt primaryWallet');

    res.json({
      inactiveReferrals: inactiveReferrals.map(u => ({
        id: u._id,
        name: u.username,
        email: u.email,
        phone: u.phone,
        walletBalance: u.primaryWallet.balance,
        joinedAt: u.createdAt,
        daysSinceJoined: Math.floor((Date.now() - u.createdAt) / 86400000)
      })),
      total: inactiveReferrals.length,
      note: 'These are users you invited who have not yet activated their package.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
const express = require('express');
const User = require('../models/Users');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Get profile
router.get('/profile', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        phone: user.phone,
        status: user.status,
        packageType: user.packageType,
        hasActivated: user.hasActivated,
        inviteCode: user.uniqueInviteCode,
        inviteLink: user.inviteLink,
        primaryWallet: user.primaryWallet,
        pointsWallet: user.pointsWallet,
        stats: user.stats,
        dailyTasks: user.dailyTasks,
        createdAt: user.createdAt,
        lastLogin: user.lastLogin,
        canWithdrawPoints: user.canWithdrawPoints ? user.canWithdrawPoints() : false
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Change password
router.put('/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password required.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'New password must be different from current password.' });
    }

    const user = await User.findById(req.userId);
    const isMatch = await user.comparePassword(currentPassword);

    if (!isMatch) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    user.password = newPassword;
    await user.save();

    res.json({ message: '✅ Password changed successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get user dashboard data
router.get('/dashboard', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });

    const today = new Date().toISOString().slice(0, 10);
    const dailyBlogsLeft = user.dailyTasks.date === today ? 2 - user.dailyTasks.blogsCompleted : 2;
    const dailySurveysLeft = user.dailyTasks.date === today ? 2 - user.dailyTasks.surveysCompleted : 2;

    // Direct referrals
    const directReferrals = await User.find({ referrerId: user._id })
      .select('username email phone status packageType createdAt')
      .lean();

    res.json({
      profile: {
        id: user._id, username: user.username, email: user.email,
        phone: user.phone, status: user.status, packageType: user.packageType,
        hasActivated: user.hasActivated, joinedAt: user.createdAt
      },
      wallets: {
        primary: { balance: user.primaryWallet.balance, currency: 'KES' },
        points: {
          points: user.pointsWallet.points,
          totalEarned: user.pointsWallet.totalEarned,
          kesEquivalent: Math.floor(user.pointsWallet.points / 100) * 10,
          canConvert: user.canWithdrawPoints ? user.canWithdrawPoints() : false
        }
      },
      stats: {
        totalReferrals: user.stats.totalReferrals,
        activeDirectReferrals: user.stats.activeDirectReferrals,
        totalEarnings: user.stats.totalEarnings,
        blogsWritten: user.stats.blogsWritten,
        surveysCompleted: user.stats.surveysCompleted
      },
      dailyProgress: {
        date: today,
        blogsLeft: Math.max(0, dailyBlogsLeft),
        surveysLeft: Math.max(0, dailySurveysLeft),
        maxPerDay: 2
      },
      inviteCode: user.uniqueInviteCode,
      inviteLink: user.inviteLink?.includes('undefined') || !user.inviteLink
        ? `${req.headers['x-forwarded-proto'] || req.protocol || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host || ''}/#join?ref=${user.uniqueInviteCode}`
        : user.inviteLink,
      directReferrals: directReferrals.map(r => ({
        id: r._id, username: r.username, email: r.email, phone: r.phone,
        status: r.status, packageType: r.packageType, joinedAt: r.createdAt
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get inactive referrals (visible to parent/father only)
router.get('/inactive-referrals', authMiddleware, async (req, res) => {
  try {
    const inactiveReferrals = await User.find({
      referrerId: req.userId,
      packageType: 'not_active'
    }).select('username email phone createdAt primaryWallet');

    res.json({
      inactiveReferrals: inactiveReferrals.map(u => ({
        id: u._id,
        name: u.username,
        email: u.email,
        phone: u.phone,
        walletBalance: u.primaryWallet.balance,
        joinedAt: u.createdAt,
        daysSinceJoined: Math.floor((Date.now() - u.createdAt) / 86400000)
      })),
      total: inactiveReferrals.length,
      note: 'These are users you invited who have not yet activated their package.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
