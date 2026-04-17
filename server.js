require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

require('./db');
const { handleIncomingMessage, sendManualMessage } = require('./handlers/whatsapp');
const { get, all, run } = require('./handlers/db-utils');

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
app.get('/api/conversations', async (req, res) => {
  try {
    const convs = await all(`
      SELECT c.id, c.phone_number, c.status, c.bot_paused, c.created_at, c.updated_at, COUNT(m.id) as message_count
      FROM conversations c
      LEFT JOIN messages m ON c.id = m.conversation_id
      GROUP BY c.id
      ORDER BY c.updated_at DESC
    `);

    res.json(convs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Get conversation messages
app.get('/api/conversations/:id/messages', async (req, res) => {
  try {
    const messages = await all(`
      SELECT * FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC
    `, [req.params.id]);

    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Pause/Resume bot
app.post('/api/conversations/:id/pause', async (req, res) => {
  try {
    const { paused } = req.body;
    await run('UPDATE conversations SET bot_paused = ? WHERE id = ?', [paused ? 1 : 0, req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Send manual message
app.post('/api/conversations/:id/send', async (req, res) => {
  try {
    const { message } = req.body;
    const conv = await get('SELECT phone_number FROM conversations WHERE id = ?', [req.params.id]);

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
app.get('/api/reports', async (req, res) => {
  try {
    const totalConvs = await get('SELECT COUNT(*) as count FROM conversations');
    const totalMessages = await get('SELECT COUNT(*) as count FROM messages');
    const activeConvs = await get('SELECT COUNT(*) as count FROM conversations WHERE status = ?', ['active']);

    const messagesByDay = await all(`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM messages
      GROUP BY DATE(created_at)
      ORDER BY date DESC LIMIT 7
    `);

    res.json({
      totalConversations: totalConvs?.count || 0,
      totalMessages: totalMessages?.count || 0,
      activeConversations: activeConvs?.count || 0,
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
