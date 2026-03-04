const Commission = require('../models/Commission');
const User = require('../models/Users');

// Level 1: Father (direct referrer) = 200
// Level 2: Grandfather = 150
// Level 3: Great-grandfather = 75
// Level 4: Great-great-grandfather = 25
const COMMISSION_LEVELS = {
  1: 200,
  2: 150,
  3: 75,
  4: 25
};

const LEVEL_NAMES = {
  1: 'Father (Direct Referrer)',
  2: 'Grandfather',
  3: 'Great-Grandfather',
  4: 'Great-Great-Grandfather'
};

/**
 * Distributes commissions with support for Database Transactions
 * @param {Object} newUser - The user being activated
 * @param {String} activationType - Type of activation
 * @param {Object} session - Mongoose session for rollback support
 */
async function distributeReferralCommissions(newUser, activationType = 'user', session = null) {
  try {
    const commissions = [];
    let currentReferrerId = newUser.referrerId;
    let level = 1;

    console.log(`📊 Transactional Commission distribution for: ${newUser.username}`);

    while (currentReferrerId && level <= 4) {
      // Fetch referrer using the session
      const referrer = await User.findById(currentReferrerId).session(session);
      if (!referrer) break;

      const amount = COMMISSION_LEVELS[level];

      console.log(`✅ Level ${level} - ${LEVEL_NAMES[level]}: ${referrer.username} gets KES ${amount}`);

      // Add to referrer wallet within session
      referrer.primaryWallet.balance += amount;
      referrer.stats.totalEarnings = (referrer.stats.totalEarnings || 0) + amount;

      commissions.push({
        fromUserId: newUser._id,
        toUserId: referrer._id,
        level: level,
        amount: amount,
        type: 'referral_commission',
        status: 'completed',
        description: `Level ${level} commission from ${newUser.username} activation (${LEVEL_NAMES[level]})`,
        metadata: { newUserId: newUser._id, chainLevel: LEVEL_NAMES[level] }
      });

      // Save the referrer update within the session
      await referrer.save({ session });
      
      currentReferrerId = referrer.referrerId;
      level++;
    }

    if (commissions.length > 0) {
      // Insert many commission records within the session
      await Commission.insertMany(commissions, { session });
    }

    console.log(`📈 Transactional Commissions prepared: ${commissions.length} records`);
    return commissions;
  } catch (error) {
    console.error('❌ Commission error (Triggering Rollback):', error.message);
    // Rethrow error so the auth.js catch block triggers abortTransaction()
    throw error;
  }
}

module.exports = { distributeReferralCommissions, getReferralChain };

async function getReferralChain(userId) {
  const chain = [];
  const user = await User.findById(userId).select('referrerId username');
  let currentId = user && user.referrerId;
  let level = 1;
  while (currentId && level <= 4) {
    const referrer = await User.findById(currentId).select('username email phone _id referrerId');
    if (!referrer) break;
    chain.push({ level, userId: referrer._id, username: referrer.username, email: referrer.email, phone: referrer.phone || '' });
    currentId = referrer.referrerId;
    level++;
  }
  return chain;
}
