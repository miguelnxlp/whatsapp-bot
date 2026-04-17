require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const db = require('./db');
const { handleIncomingMessage, sendManualMessage } = require('./handlers/whatsapp');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// WhatsApp Webhook Verification
app.get('/webhook', (req, res) => {
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (token === process.env.VERIFY_TOKEN) {
    res.send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Receive WhatsApp Messages
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      const entries = body.entry || [];

      for (const entry of entries) {
        const changes = entry.changes || [];

        for (const change of changes) {
          if (change.field === 'messages') {
            const messages = change.value.messages || [];

            for (const message of messages) {
              const phoneNumber = message.from;
              const messageText = message.text?.body;

              if (messageText) {
                await handleIncomingMessage(phoneNumber, messageText);
              }
            }
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500);
  }
});

// API: Get all conversations
app.get('/api/conversations', (req, res) => {
  try {
    const convs = db.prepare(`
      SELECT c.*, COUNT(m.id) as message_count
      FROM conversations c
      LEFT JOIN messages m ON c.id = m.conversation_id
      GROUP BY c.id
      ORDER BY c.updated_at DESC
    `).all();

    res.json(convs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Get conversation messages
app.get('/api/conversations/:id/messages', (req, res) => {
  try {
    const messages = db.prepare(`
      SELECT * FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC
    `).all(req.params.id);

    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Pause/Resume bot
app.post('/api/conversations/:id/pause', (req, res) => {
  try {
    const { paused } = req.body;
    db.prepare('UPDATE conversations SET bot_paused = ? WHERE id = ?').run(paused ? 1 : 0, req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Send manual message
app.post('/api/conversations/:id/send', async (req, res) => {
  try {
    const { message } = req.body;
    const conv = db.prepare('SELECT phone_number FROM conversations WHERE id = ?').get(req.params.id);

    if (!conv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    await sendManualMessage(conv.phone_number, message);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Get reports
app.get('/api/reports', (req, res) => {
  try {
    const totalConvs = db.prepare('SELECT COUNT(*) as count FROM conversations').get();
    const totalMessages = db.prepare('SELECT COUNT(*) as count FROM messages').get();
    const activeConvs = db.prepare('SELECT COUNT(*) as count FROM conversations WHERE status = "active"').get();

    const messagesByDay = db.prepare(`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM messages
      GROUP BY DATE(created_at)
      ORDER BY date DESC LIMIT 7
    `).all();

    res.json({
      totalConversations: totalConvs.count,
      totalMessages: totalMessages.count,
      activeConversations: activeConvs.count,
      messagesByDay,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
});
