const express = require('express');
const User = require('../models/Users');
const Commission = require('../models/Commission');
const { authMiddleware } = require('../middleware/auth');
const { getReferralChain } = require('../utils/commissionHelper');

const router = express.Router();

// ==================== REFERRAL STATS WITH FULL USER DETAILS PER LEVEL ====================
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);

    // Fetch all 4 levels with full user details
    const level1Users = await User.find({ referrerId: user._id })
      .select('username email phone status packageType createdAt activatedAt');

    const level1Ids = level1Users.map(u => u._id);
    const level2Users = await User.find({ referrerId: { $in: level1Ids } })
      .select('username email phone status packageType createdAt activatedAt referrerId');

    const level2Ids = level2Users.map(u => u._id);
    const level3Users = await User.find({ referrerId: { $in: level2Ids } })
      .select('username email phone status packageType createdAt activatedAt referrerId');

    const level3Ids = level3Users.map(u => u._id);
    const level4Users = await User.find({ referrerId: { $in: level3Ids } })
      .select('username email phone status packageType createdAt activatedAt referrerId');

    // Format user for table display
    const formatUser = (u) => ({
      id: u._id,
      username: u.username,
      email: u.email,
      phone: u.phone,
      status: u.status,
      packageType: u.packageType,
      isActive: u.packageType === 'normal' && u.status === 'active',
      joinedAt: u.createdAt,
      activatedAt: u.activatedAt || null
    });

    // Split each level into active and inactive tables
    const splitLevel = (users) => {
      const formatted = users.map(formatUser);
      return {
        count: users.length,
        activeCount: formatted.filter(u => u.isActive).length,
        inactiveCount: formatted.filter(u => !u.isActive).length,
        active: formatted.filter(u => u.isActive),
        inactive: formatted.filter(u => !u.isActive)
      };
    };

    // Commission earnings per level
    const commissions = await Commission.find({ toUserId: user._id, type: 'referral_commission' });
    const byLevel = {
      level1: commissions.filter(c => c.level === 1).reduce((s, c) => s + c.amount, 0),
      level2: commissions.filter(c => c.level === 2).reduce((s, c) => s + c.amount, 0),
      level3: commissions.filter(c => c.level === 3).reduce((s, c) => s + c.amount, 0),
      level4: commissions.filter(c => c.level === 4).reduce((s, c) => s + c.amount, 0)
    };

    const l1 = splitLevel(level1Users);
    const l2 = splitLevel(level2Users);
    const l3 = splitLevel(level3Users);
    const l4 = splitLevel(level4Users);

    res.json({
      summary: {
        totalReferrals: l1.count + l2.count + l3.count + l4.count,
        directReferrals: l1.count,
        activeDirectReferrals: l1.activeCount,
        newReferralsSinceLastWithdrawal: user.pointsWallet.referralsSinceLastWithdrawal || 0,
        totalCommission: commissions.reduce((s, c) => s + c.amount, 0),
        commissionByLevel: byLevel
      },
      levels: {
        level1: { commissionPerActivation: 200, ...l1 },
        level2: { commissionPerActivation: 150, ...l2 },
        level3: { commissionPerActivation: 75,  ...l3 },
        level4: { commissionPerActivation: 25,  ...l4 }
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== REFERRAL LINK ====================
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

// ==================== REFERRAL CHAIN ====================
router.get('/chain', authMiddleware, async (req, res) => {
  try {
    const chain = await getReferralChain(req.userId);
    res.json({ chain });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
