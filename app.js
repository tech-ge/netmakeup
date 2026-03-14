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

const connectDB = require('./config/db');

const app = express();

console.log('🚀 Starting TechGeo Network Platform...');

// ─── Security headers ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options',    'nosniff');
  res.setHeader('X-Frame-Options',           'DENY');
  res.setHeader('X-XSS-Protection',          '1; mode=block');
  res.setHeader('Referrer-Policy',           'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy',        'geolocation=(), microphone=(), camera=()');
  next();
});

app.set('trust proxy', 1);

app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
// ─── Paystack webhook — must use raw body BEFORE express.json ────────────────
app.use('/api/paystack/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Global rate limit ────────────────────────────────────────────────────────
app.use(globalLimiter);

// ─── DB connection middleware (handles Vercel cold starts) ────────────────────
app.use('/api', async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error('❌ DB connection failed:', err.message);
    return res.status(503).json({ error: 'Database unavailable. Please try again.' });
  }
});

// ─── Auth routes ──────────────────────────────────────────────────────────────
const authRouter = require('./api/auth');
app.use('/api/auth/signup',          registerLimiter);
app.use('/api/auth/change-password', sensitiveActionLimiter);
app.use('/api/auth/reset-password',  sensitiveActionLimiter);
app.use('/api/auth',                 authLimiter, authRouter);

// ─── Withdrawal routes ────────────────────────────────────────────────────────
app.use('/api/withdrawals', (req, res, next) => {
  if (req.path.startsWith('/admin')) return next();
  return withdrawalLimiter(req, res, next);
}, require('./api/withdrawal'));

// ─── Task routes ──────────────────────────────────────────────────────────────
app.use('/api/blogs',          taskSubmitLimiter, require('./api/blog'));
app.use('/api/surveys',        taskSubmitLimiter, require('./api/surveys'));
app.use('/api/writing',        taskSubmitLimiter, require('./api/writingJobs'));
app.use('/api/transcriptions', taskSubmitLimiter, require('./api/transcription'));
app.use('/api/dataentry',      taskSubmitLimiter, require('./api/dataEntry'));

app.use('/api/paystack', require('./api/paystack'));

// ─── Notification routes ──────────────────────────────────────────────────────
app.use('/api/notifications', require('./api/notifications'));

// ─── AI chat routes ───────────────────────────────────────────────────────────
// FIX: was missing — caused all /api/ai/* to return 404
app.use('/api/ai', require('./api/ai'));

// ─── Admin routes ─────────────────────────────────────────────────────────────
app.use('/api/admin',    adminLimiter, require('./api/admin'));

// ─── User / wallet / referral routes ─────────────────────────────────────────
app.use('/api/users',     require('./api/user'));
app.use('/api/wallets',   require('./api/wallet'));
app.use('/api/referrals', require('./api/refferals'));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const mongoose = require('mongoose');
  res.json({
    status: 'OK',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

// ─── 404 for unknown API routes ───────────────────────────────────────────────
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.stack);
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'File too large. Max 5MB for JSON, 50MB for audio, 20MB for documents.' });
  }
  res.status(500).json({
    error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
  });
});

module.exports = app;
