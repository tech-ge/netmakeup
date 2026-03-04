const express = require('express');
const User = require('../models/Users');
const Commission = require('../models/Commission');
const { authMiddleware } = require('../middleware/auth');
const { getReferralChain } = require('../utils/commissionHelper');

const router = express.Router();

// Get referral stats
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);

    const level1 = await User.find({ referrerId: user._id }).select('username email status packageType createdAt');
    const level1Ids = level1.map(u => u._id);
    const level2 = await User.find({ referrerId: { $in: level1Ids } }).select('username email status packageType referrerId createdAt');
    const level2Ids = level2.map(u => u._id);
    const level3 = await User.find({ referrerId: { $in: level2Ids } }).select('username email status packageType referrerId createdAt');
    const level3Ids = level3.map(u => u._id);
    const level4 = await User.find({ referrerId: { $in: level3Ids } }).select('username email status packageType referrerId createdAt');

    const commissions = await Commission.find({ toUserId: user._id, type: 'referral_commission' });
    const byLevel = {
      level1: commissions.filter(c => c.level === 1).reduce((s, c) => s + c.amount, 0),
      level2: commissions.filter(c => c.level === 2).reduce((s, c) => s + c.amount, 0),
      level3: commissions.filter(c => c.level === 3).reduce((s, c) => s + c.amount, 0),
      level4: commissions.filter(c => c.level === 4).reduce((s, c) => s + c.amount, 0)
    };

    res.json({
      summary: {
        totalReferrals: level1.length + level2.length + level3.length + level4.length,
        directReferrals: level1.length,
        activeDirectReferrals: user.stats.activeDirectReferrals || 0,
        totalCommission: commissions.reduce((s, c) => s + c.amount, 0),
        commissionByLevel: byLevel
      },
      levels: {
        level1: { count: level1.length, commission: 200, users: level1.map(u => ({ id: u._id, username: u.username, status: u.status, packageType: u.packageType, joinedAt: u.createdAt })) },
        level2: { count: level2.length, commission: 150, users: level2.map(u => ({ id: u._id, username: u.username, status: u.status, packageType: u.packageType, joinedAt: u.createdAt })) },
        level3: { count: level3.length, commission: 75, users: level3.map(u => ({ id: u._id, username: u.username, status: u.status, packageType: u.packageType, joinedAt: u.createdAt })) },
        level4: { count: level4.length, commission: 25, users: level4.map(u => ({ id: u._id, username: u.username, status: u.status, packageType: u.packageType, joinedAt: u.createdAt })) }
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get referral link
router.get('/link', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const baseUrl = process.env.FRONTEND_URL || (host ? `${protocol}://${host}` : '');
    const link = `${baseUrl}/#join?ref=${user.uniqueInviteCode}`;

    res.json({
      inviteLink: link,
      inviteCode: user.uniqueInviteCode,
      shareLinks: {
        whatsapp: `https://wa.me/?text=Join%20TechGeo%20Network!%20Use%20my%20link:%20${encodeURIComponent(link)}`,
        facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(link)}`,
        twitter: `https://twitter.com/intent/tweet?text=Join%20TechGeo%20Network!&url=${encodeURIComponent(link)}`
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get referral chain
router.get('/chain', authMiddleware, async (req, res) => {
  try {
    const chain = await getReferralChain(req.userId);
    res.json({ chain });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
