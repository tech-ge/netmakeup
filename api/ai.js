const express = require('express');
const https   = require('https');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
const GROQ_MODEL = 'llama3-8b-8192';

const BOT_CONTEXTS = {
  dashboard: {
    name: 'Dashboard Assistant',
    system: `You are TechGeo Bot for TechGeo Network platform.
ONLY answer questions about:
- Account activation: one-time KES 700 fee, unlocks all tasks and earnings.
- Referral commissions per KES 700 activation: Level 1 KES 200, Level 2 KES 150, Level 3 KES 75, Level 4 KES 25.
- KES wallet withdrawals: no minimum, processed every Thursday via M-Pesa or bank.
- Points wallet withdrawals: need 2000+ points AND 4 new referrals since last withdrawal, processed every Tuesday.
- Client follow-up: share invite link, remind them activation unlocks earnings, follow up after 24 hours.
- Getting clients: post in WhatsApp groups, Facebook groups, direct message people about the earning opportunity.
Reply in exactly 2 to 4 short lines. No emojis. Direct and factual only.
If asked anything else reply: I only answer questions about TechGeo platform operations.`
  },
  blog: {
    name: 'Blog Assistant',
    system: `You are TechGeo Bot, a blog ideas assistant for TechGeo Network.
Help with: topic ideas, article structure, opening lines, engaging content, meeting word count.
Never write the blog for them. Short practical tips only. Max 100 words. No emojis.
Off-topic reply: I only assist with blog tasks.`
  },
  survey: {
    name: 'Survey Assistant',
    system: `You are TechGeo Bot, a survey helper for TechGeo Network.
Help with: answering clearly, good text responses, rating questions, avoiding vague answers that get rejected.
Never answer the survey for them. Max 100 words. No emojis.
Off-topic reply: I only assist with survey tasks.`
  },
  transcription: {
    name: 'Transcription Assistant',
    system: `You are TechGeo Bot, a transcription helper for TechGeo Network.
Help with: listening tips, handling unclear audio, punctuation and formatting, accuracy, common mistakes.
Never transcribe audio for them. Max 100 words. No emojis.
Off-topic reply: I only assist with transcription tasks.`
  },
  writing: {
    name: 'Writing Assistant',
    system: `You are TechGeo Bot, a writing job helper for TechGeo Network.
Help with: understanding briefs, choosing format, structuring documents, meeting word count, professional writing.
Never write the document for them. Max 100 words. No emojis.
Off-topic reply: I only assist with writing tasks.`
  },
  dataentry: {
    name: 'Data Entry Assistant',
    system: `You are TechGeo Bot, a data entry helper for TechGeo Network.
Help with: reading templates, filling data correctly, formatting spreadsheets, accuracy tips, avoiding errors, submitting files.
Never fill in data for them. Max 100 words. No emojis.
Off-topic reply: I only assist with data entry tasks.`
  }
};

function callGroq(messages) {
  return new Promise(function(resolve, reject) {
    const body = JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: 180, temperature: 0.45 });
    const opts = {
      hostname: 'api.groq.com', port: 443, path: '/openai/v1/chat/completions', method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const p = JSON.parse(raw);
          if (p.error) return reject(new Error(p.error.message || 'Groq error'));
          resolve((p.choices?.[0]?.message?.content || '').trim());
        } catch(e) { reject(new Error('Invalid Groq response')); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// POST /api/ai/chat
router.post('/chat', authMiddleware, async (req, res) => {
  try {
    const { type, message, history = [] } = req.body;
    if (!type || !BOT_CONTEXTS[type]) return res.status(400).json({ error: 'Invalid bot type.' });
    if (!message || !message.trim())    return res.status(400).json({ error: 'Message required.' });

    const words = message.trim().split(/\s+/).filter(Boolean).length;
    if (words > 20) return res.status(400).json({ error: 'Keep your message to 20 words or less.' });

    const ctx = BOT_CONTEXTS[type];
    const recent = Array.isArray(history)
      ? history.slice(-6).map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: String(h.content).substring(0, 300) }))
      : [];

    const messages = [{ role: 'system', content: ctx.system }, ...recent, { role: 'user', content: message.trim() }];
    const reply    = await callGroq(messages);
    const wArr     = reply.split(/\s+/);
    const safe     = wArr.length > 105 ? wArr.slice(0, 100).join(' ') + '...' : reply;

    res.json({ reply: safe, botName: ctx.name });
  } catch(err) {
    console.error('AI chat error:', err.message);
    res.status(500).json({ error: 'AI unavailable. Please try again.' });
  }
});

// GET /api/ai/greeting?type=dashboard
router.get('/greeting', authMiddleware, (req, res) => {
  const { type } = req.query;
  if (!type || !BOT_CONTEXTS[type]) return res.status(400).json({ error: 'Invalid bot type.' });
  const name      = req.user?.username || 'there';
  const taskLabel = type === 'dashboard' ? 'platform operations' : `${type} tasks`;
  res.json({
    greeting: `Hello ${name}, I am TechGeo Bot, here to answer questions about ${taskLabel}.`,
    botName:  BOT_CONTEXTS[type].name
  });
});

module.exports = router;
