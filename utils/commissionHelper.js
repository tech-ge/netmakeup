const Commission = require('../models/Commission');
const User = require('../models/Users');

// Activation fee: KES 700. Business profit per activation: KES 250
// Commission payout per activation: KES 200+150+75+25 = KES 450
// Profit = 700 - 450 = KES 250 per activation

const COMMISSION_LEVELS = { 1: 200, 2: 150, 3: 75, 4: 25 };
const ACTIVATION_FEE = 700;
const PROFIT_PER_ACTIVATION = 250; // KES 250 goes to profit pool

const LEVEL_NAMES = {
  1: 'Father (Direct Referrer)',
  2: 'Grandfather',
  3: 'Great-Grandfather',
  4: 'Great-Great-Grandfather'
};

/**
 * Distributes commissions and increments referralsSinceLastWithdrawal
 * for each upline beneficiary so they can unlock points withdrawal.
 */
async function distributeReferralCommissions(newUser, activationType = 'user', session = null) {
  try {
    const commissions = [];
    let currentReferrerId = newUser.referrerId;
    let level = 1;

    console.log(`📊 Commission distribution for: ${newUser.username}`);

    while (currentReferrerId && level <= 4) {
      const referrer = await User.findById(currentReferrerId).session(session);
      if (!referrer) break;

      const amount = COMMISSION_LEVELS[level];
      console.log(`✅ Level ${level} - ${LEVEL_NAMES[level]}: ${referrer.username} gets KES ${amount}`);

      referrer.primaryWallet.balance += amount;
      referrer.stats.totalEarnings = (referrer.stats.totalEarnings || 0) + amount;

      // Increment new referral count for points withdrawal eligibility
      // Only level 1 (direct referrer) counts as "their referral"
      if (level === 1) {
        referrer.pointsWallet.referralsSinceLastWithdrawal =
          (referrer.pointsWallet.referralsSinceLastWithdrawal || 0) + 1;
      }

      commissions.push({
        fromUserId: newUser._id,
        toUserId: referrer._id,
        level,
        amount,
        type: 'referral_commission',
        status: 'completed',
        description: `Level ${level} commission from ${newUser.username} activation (${LEVEL_NAMES[level]})`,
        metadata: { newUserId: newUser._id, chainLevel: LEVEL_NAMES[level] }
      });

      await referrer.save({ session });
      currentReferrerId = referrer.referrerId;
      level++;
    }

    if (commissions.length > 0) {
      await Commission.insertMany(commissions, { session });
    }

    console.log(`📈 Commissions prepared: ${commissions.length} records`);
    return commissions;
  } catch (error) {
    console.error('❌ Commission error (Triggering Rollback):', error.message);
    throw error;
  }
}

/**
 * Get referral chain for a user
 */
async function getReferralChain(userId) {
  const chain = [];
  const user = await User.findById(userId).select('referrerId username');
  let currentId = user?.referrerId;
  let level = 1;

  while (currentId && level <= 4) {
    const referrer = await User.findById(currentId).select('username email _id referrerId');
    if (!referrer) break;
    chain.push({ level, userId: referrer._id, username: referrer.username, email: referrer.email });
    currentId = referrer.referrerId;
    level++;
  }

  return chain;
}

module.exports = { distributeReferralCommissions, getReferralChain, PROFIT_PER_ACTIVATION, ACTIVATION_FEE };