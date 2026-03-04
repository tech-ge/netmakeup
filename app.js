const express = require('express');
const cors    = require('cors');
const path    = require('path');

const {
  globalLimiter,
  authLimiter,
  registerLimiter,
  withdrawalLimiter,
  taskSubmitLimiter,
  adminLimiter,
  sensitiveActionLimiter
} = require('./middleware/rateLimiter');

const app = express();

console.log('🚀 Starting TechGeo Network Platform...');

// ─── Security headers ───────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options',    'nosniff');
  res.setHeader('X-Frame-Options',           'DENY');
  res.setHeader('X-XSS-Protection',          '1; mode=block');
  res.setHeader('Referrer-Policy',           'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy',        'geolocation=(), microphone=(), camera=()');
  next();
});

// Trust proxy — needed for accurate IP detection behind Vercel / Nginx / Heroku
app.set('trust proxy', 1);

app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Global rate limit (all routes) ─────────────────────────────────────────
app.use(globalLimiter);

// ─── Auth routes — tightest limits ──────────────────────────────────────────
// POST /api/auth/signup    → registerLimiter (5/hr)  then authLimiter (10/15min)
// POST /api/auth/login     → authLimiter (10/15min)
// PUT  /api/auth/*/password→ sensitiveActionLimiter (3/hr)
const authRouter = require('./api/auth');
app.use('/api/auth/signup', registerLimiter);             // registration cap first
app.use('/api/auth/change-password', sensitiveActionLimiter);
app.use('/api/auth/reset-password',  sensitiveActionLimiter);
app.use('/api/auth', authLimiter, authRouter);            // all auth: 10/15min

// ─── Withdrawal routes — money endpoints ─────────────────────────────────────
app.use('/api/withdrawals', withdrawalLimiter, require('./api/withdrawal'));

// ─── Task submission routes — prevent spamming ───────────────────────────────
app.use('/api/blogs',          taskSubmitLimiter, require('./api/blog'));
app.use('/api/surveys',        taskSubmitLimiter, require('./api/surveys'));
// Additional task routes (transcription, writing, dataentry) if they exist:
['transcriptions', 'writing', 'dataentry'].forEach(route => {
  try {
    app.use(`/api/${route}`, taskSubmitLimiter, require(`./api/${route}`));
  } catch (_) {
    // Route file not yet created — skip silently
  }
});

// ─── Admin routes ─────────────────────────────────────────────────────────────
app.use('/api/admin', adminLimiter, require('./api/admin'));

// ─── Remaining routes (no extra limit beyond global) ─────────────────────────
app.use('/api/users',     require('./api/user'));
app.use('/api/wallets',   require('./api/wallet'));
app.use('/api/referrals', require('./api/refferals'));

// ─── Health check (excluded from rate limiting in rateLimiter.js) ─────────────
app.get('/api/health', (req, res) => {
  const mongoose = require('mongoose');
  res.json({
    status: 'OK',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

// ─── 404 for unknown API routes ───────────────────────────────────────────────
app.use('/api/*', (req, res) => res.status(404).json({ error: 'API endpoint not found' }));

// ─── SPA fallback ────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.stack);
  res.status(500).json({
    error: process.env.NODE_ENV === 'development' ? err.message : 'Server error'
  });
});

module.exports = app;
