/**
 * rateLimiter.js — Rate limiting middleware for TechGeo Network
 *
 * Layers of protection:
 *  1. globalLimiter      — blanket cap on every request, stops raw floods
 *  2. authLimiter        — tight limit on login/register (brute-force prevention)
 *  3. withdrawalLimiter  — prevents automated withdrawal spam
 *  4. taskSubmitLimiter  — prevents task submission flooding
 *  5. adminLimiter       — protects admin endpoints from enumeration/scraping
 *
 * All limiters use an in-memory store (default).
 * For multi-instance deployments swap to redis store:
 *   npm install rate-limit-redis ioredis
 *   const RedisStore = require('rate-limit-redis');
 *   store: new RedisStore({ client: redisClient })
 */

const rateLimit = require('express-rate-limit');

// Helper: standard JSON error response
const jsonHandler = (req, res) => {
  res.status(429).json({
    error: 'Too many requests. Please slow down and try again later.',
    retryAfter: Math.ceil(res.getHeader('Retry-After') || 60)
  });
};

// ─────────────────────────────────────────────
// 1. GLOBAL — every incoming request
//    500 req / 15 min per IP
// ─────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,   // Return RateLimit-* headers (RFC 6585)
  legacyHeaders: false,
  handler: jsonHandler,
  skip: (req) => req.path === '/api/health' // never throttle health check
});

// ─────────────────────────────────────────────
// 2. AUTH — /api/auth/* (login, register, password)
//    Tight: 10 attempts / 15 min per IP
//    This is the main brute-force defence.
//    Account lockout (in Users.js) is the second layer.
// ─────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many login attempts. Account may be temporarily locked. Try again in 15 minutes.',
      retryAfter: 900
    });
  }
});

// ─────────────────────────────────────────────
// 3. REGISTRATION — stricter than login
//    5 new accounts / hour per IP
// ─────────────────────────────────────────────
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many registration attempts from this IP. Please try again in 1 hour.',
      retryAfter: 3600
    });
  }
});

// ─────────────────────────────────────────────
// 4. WITHDRAWAL — /api/withdrawals/*
//    5 requests / hour per IP (extra protection on money endpoints)
// ─────────────────────────────────────────────
const withdrawalLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many withdrawal requests. Please try again in 1 hour.',
      retryAfter: 3600
    });
  }
});

// ─────────────────────────────────────────────
// 5. TASK SUBMISSION — blogs, surveys, transcription, writing, data entry
//    30 submissions / hour per IP
// ─────────────────────────────────────────────
const taskSubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonHandler
});

// ─────────────────────────────────────────────
// 6. ADMIN — /api/admin/*
//    100 req / 15 min per IP (still needs to be functional)
// ─────────────────────────────────────────────
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonHandler
});

// ─────────────────────────────────────────────
// 7. PASSWORD RESET / SENSITIVE MUTATIONS
//    3 attempts / hour per IP
// ─────────────────────────────────────────────
const sensitiveActionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many attempts on this action. Please try again in 1 hour.',
      retryAfter: 3600
    });
  }
});

module.exports = {
  globalLimiter,
  authLimiter,
  registerLimiter,
  withdrawalLimiter,
  taskSubmitLimiter,
  adminLimiter,
  sensitiveActionLimiter
};