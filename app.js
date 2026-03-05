require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
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

// ─── Connect to MongoDB Atlas ────────────────────────────────────────────────
// Called once here; db.js guards against duplicate connections (isConnected flag)
connectDB().catch(err => {
  console.error('❌ Failed to connect to MongoDB on startup:', err.message);
  process.exit(1);
});

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

// Trust Vercel / Nginx proxy for accurate client IP (needed for rate limiting)
app.set('trust proxy', 1);

app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Global rate limit ───────────────────────────────────────────────────────
app.use(globalLimiter);

// ─── Auth routes ─────────────────────────────────────────────────────────────
const authRouter = require('./api/auth');
app.use('/api/auth/signup',          registerLimiter);
app.use('/api/auth/change-password', sensitiveActionLimiter);
app.use('/api/auth/reset-password',  sensitiveActionLimiter);
app.use('/api/auth', authLimiter, authRouter);

// ─── Withdrawal routes ────────────────────────────────────────────────────────
app.use('/api/withdrawals', withdrawalLimiter, require('./api/withdrawal'));

// ─── Task routes (with submission rate limiting) ──────────────────────────────
app.use('/api/blogs',          taskSubmitLimiter, require('./api/blog'));
app.use('/api/surveys',        taskSubmitLimiter, require('./api/surveys'));
app.use('/api/transcriptions', taskSubmitLimiter, require('./api/transcription'));
app.use('/api/writing',        taskSubmitLimiter, require('./api/writingJobs'));
app.use('/api/dataentry',      taskSubmitLimiter, require('./api/dataEntry'));

// ─── Admin routes ─────────────────────────────────────────────────────────────
app.use('/api/admin', adminLimiter, require('./api/admin'));

// ─── Standard authenticated routes ───────────────────────────────────────────
app.use('/api/users',         require('./api/user'));
app.use('/api/wallets',       require('./api/wallet'));
app.use('/api/referrals',     require('./api/refferals'));
app.use('/api/notifications', require('./api/notifications')); // ← was missing

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const mongoose = require('mongoose');
  res.json({
    status:    'OK',
    database:  mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

// ─── 404 for unknown API routes ───────────────────────────────────────────────
app.use('/api/*', (req, res) => res.status(404).json({ error: 'API endpoint not found' }));

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err.stack);
  res.status(500).json({
    error: process.env.NODE_ENV === 'development' ? err.message : 'Server error'
  });
});

module.exports = app;
