const Commission = require('../models/Commission');
const User = require('../models/Users');

// ─── Business Constants ────────────────────────────────────────────────────
const ACTIVATION_FEE = 700;          // KES charged to user on activation
const COMMISSIONS_TOTAL = 450;       // KES 200+150+75+25 paid to upline chain
const PROFIT_PER_ACTIVATION = ACTIVATION_FEE - COMMISSIONS_TOTAL; // KES 250 net profit

// Level commissions paid from the KES 700 activation fee
const COMMISSION_LEVELS = { 1: 200, 2: 150, 3: 75, 4: 25 };
const LEVEL_NAMES = {
  1: 'Father (Direct Referrer)',
  2: 'Grandfather',
  3: 'Great-Grandfather',
  4: 'Great-Great-Grandfather'
};

/**
 * Distributes referral commissions up to 4 upline levels.
 * Runs inside a Mongoose session for full rollback support.
 * If ANY step fails, the caller's abortTransaction() will undo everything.
 *
 * @param {Object} newUser        - The newly activated user document (already in session)
 * @param {String} activationType - e.g. 'activation'
 * @param {Object} session        - Active Mongoose ClientSession
 * @returns {Array}               - Array of commission records created
 */
async function distributeReferralCommissions(newUser, activationType = 'activation', session) {
  if (!session) throw new Error('distributeReferralCommissions requires a session for rollback support');

  const commissions = [];
  let currentReferrerId = newUser.referrerId;
  let level = 1;

  console.log(`📊 Commission distribution starting for: ${newUser.username}`);

  while (currentReferrerId && level <= 4) {
    const referrer = await User.findById(currentReferrerId).session(session);
    if (!referrer) break;

    const amount = COMMISSION_LEVELS[level];
    console.log(`  ✅ Level ${level} — ${LEVEL_NAMES[level]}: ${referrer.username} +KES ${amount}`);

    // Credit the referrer's KES wallet
    referrer.primaryWallet.balance += amount;
    referrer.stats.totalEarnings = (referrer.stats.totalEarnings || 0) + amount;

    // Increment new-referral counter so they can eventually withdraw points
    if (level === 1) {
      referrer.pointsWallet.referralsSinceLastWithdrawal =
        (referrer.pointsWallet.referralsSinceLastWithdrawal || 0) + 1;
    }

    await referrer.save({ session }); // ← rolls back if session aborts

    commissions.push({
      fromUserId:  newUser._id,
      toUserId:    referrer._id,
      level,
      amount,
      type:        'referral_commission',
      status:      'completed',
      description: `Level ${level} commission from ${newUser.username} activation (${LEVEL_NAMES[level]})`,
      metadata:    { newUserId: newUser._id, chainLevel: LEVEL_NAMES[level] }
    });

    currentReferrerId = referrer.referrerId;
    level++;
  }

  if (commissions.length > 0) {
    await Commission.insertMany(commissions, { session }); // ← also rolls back on abort
  }

  console.log(`📈 Commissions distributed: ${commissions.length} records`);
  return commissions;
}

/**
 * Returns the upline referral chain for a given userId (up to 4 levels).
 */
async function getReferralChain(userId) {
  const chain = [];
  const user = await User.findById(userId).select('referrerId username');
  let currentId = user && user.referrerId;
  let level = 1;

  while (currentId && level <= 4) {
    const referrer = await User.findById(currentId)
      .select('username email phone _id referrerId');
    if (!referrer) break;
    chain.push({
      level,
      userId:   referrer._id,
      username: referrer.username,
      email:    referrer.email,
      phone:    referrer.phone || ''
    });
    currentId = referrer.referrerId;
    level++;
  }
  return chain;
}

module.exports = {
  distributeReferralCommissions,
  getReferralChain,
  ACTIVATION_FEE,
  PROFIT_PER_ACTIVATION,
  COMMISSION_LEVELS
};
