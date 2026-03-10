const express      = require('express');
const Notification = require('../models/Notification');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// ── Auto-delete read notifications older than 2 days ─────────────────────────
async function cleanOldNotifications(userId) {
  try {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await Notification.deleteMany({
      userId,
      isRead: true,
      createdAt: { $lt: twoDaysAgo }
    });
  } catch (e) { /* silent — never block main request */ }
}

// GET /api/notifications
router.get('/', authMiddleware, async (req, res) => {
  try {
    // Clean stale notifications first (non-blocking)
    cleanOldNotifications(req.userId);

    const notifications = await Notification.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(30);

    const unreadCount = await Notification.countDocuments({
      userId: req.userId,
      isRead: false
    });

    res.json({ notifications, unreadCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/notifications/mark-read — mark ALL as read
router.post('/mark-read', authMiddleware, async (req, res) => {
  try {
    await Notification.updateMany(
      { userId: req.userId, isRead: false },
      { $set: { isRead: true } }
    );
    // After marking read, clean anything already older than 2 days
    cleanOldNotifications(req.userId);
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/notifications/mark-read/:id — mark ONE as read
router.post('/mark-read/:id', authMiddleware, async (req, res) => {
  try {
    await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { $set: { isRead: true } }
    );
    res.json({ message: 'Notification marked as read' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/notifications/clear-read — manually clear all read notifications
router.delete('/clear-read', authMiddleware, async (req, res) => {
  try {
    const result = await Notification.deleteMany({ userId: req.userId, isRead: true });
    res.json({ message: `${result.deletedCount} read notification(s) cleared.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
