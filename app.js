const express = require('express');
const cors    = require('cors');
const path    = require('path');
const connectDB = require('./config/db');

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

// ─── Security headers ────────────────────────────────────────────────────────
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
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Global rate limit ───────────────────────────────────────────────────────
app.use(globalLimiter);

// ─── DB CONNECTION MIDDLEWARE ────────────────────────────────────────────────
// Runs before every /api/* route. On Vercel, each cold-start needs to
// (re)connect to MongoDB before any Mongoose model can be used.
app.use('/api', async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error('DB middleware error:', err.message);
    return res.status(503).json({
      error: 'Database unavailable. Please try again in a moment.',
      detail: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// ─── Auth routes ─────────────────────────────────────────────────────────────
const authRouter = require('./api/auth');
app.use('/api/auth/signup',          registerLimiter);
app.use('/api/auth/change-password', sensitiveActionLimiter);
app.use('/api/auth/reset-password',  sensitiveActionLimiter);
app.use('/api/auth', authLimiter, authRouter);

// ─── Withdrawal routes ───────────────────────────────────────────────────────
app.use('/api/withdrawals', withdrawalLimiter, require('./api/withdrawal'));

// ─── Task routes ─────────────────────────────────────────────────────────────
app.use('/api/blogs',    taskSubmitLimiter, require('./api/blog'));
app.use('/api/surveys',  taskSubmitLimiter, require('./api/surveys'));

// Writing jobs: file is writingJobs.js, mounted at /api/writing
app.use('/api/writing',        taskSubmitLimiter, require('./api/writingJobs'));
// Transcription: file is transcription.js, mounted at /api/transcriptions
app.use('/api/transcriptions', taskSubmitLimiter, require('./api/transcription'));
// Data entry: file is dataEntry.js (capital E), mounted at /api/dataentry
app.use('/api/dataentry',      taskSubmitLimiter, require('./api/dataEntry'));

// ─── Admin routes ────────────────────────────────────────────────────────────
app.use('/api/admin', adminLimiter, require('./api/admin'));

// ─── User / wallet / referral / notification routes ──────────────────────────
app.use('/api/users',         require('./api/user'));
app.use('/api/wallets',       require('./api/wallet'));
app.use('/api/referrals',     require('./api/refferals'));
app.use('/api/notifications', require('./api/notifications'));

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const mongoose = require('mongoose');
  const state = ['disconnected','connected','connecting','disconnecting'];
  res.json({
    status: 'OK',
    database: state[mongoose.connection.readyState] || 'unknown',
    timestamp: new Date().toISOString()
  });
});

// ─── 404 for unknown API routes ──────────────────────────────────────────────
app.use('/api/*', (req, res) => res.status(404).json({ error: 'API endpoint not found' }));

// ─── SPA fallback ────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Global error handler ────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.stack);
  res.status(500).json({
    error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
  });
});

module.exports = app;
