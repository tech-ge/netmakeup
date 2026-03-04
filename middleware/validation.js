const validateSignup = (req, res, next) => {
  const { username, email, phone, password, referrerCode } = req.body;
  const errors = [];

  if (!username || username.trim().length < 3) errors.push('Username must be at least 3 characters');
  if (!email || !email.match(/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/)) errors.push('Valid email required');
  if (!phone || phone.trim().length < 9) errors.push('Valid phone number required (at least 9 digits)');
  if (!password || password.length < 6) errors.push('Password must be at least 6 characters');
  if (!referrerCode || !referrerCode.trim()) errors.push('Referral code is required to join');

  if (errors.length > 0) return res.status(400).json({ errors });
  next();
};

module.exports = { validateSignup };
