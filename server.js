require('dotenv').config();

const express = require('express');
const axios = require('axios');
const { OpenAI } = require('openai');
const { data, saveData } = require('./db');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Webhook verification
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

// Receive messages
app.post('/webhook', async (req, res) => {
  try {
    const messages = req.body.entry?.[0]?.changes?.[0]?.value?.messages || [];

    for (const msg of messages) {
      const phone = msg.from;
      const text = msg.text?.body;

      if (!text) continue;

      // Find or create conversation
      let conv = data.conversations.find(c => c.phone_number === phone);
      if (!conv) {
        conv = {
          id: (data.conversations.length > 0 ? Math.max(...data.conversations.map(c => c.id)) : 0) + 1,
          phone_number: phone,
          status: 'active',
          bot_paused: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        data.conversations.push(conv);
      }

      // Save user message
      data.messages.push({
        id: (data.messages.length > 0 ? Math.max(...data.messages.map(m => m.id)) : 0) + 1,
        conversation_id: conv.id,
        sender: 'user',
        message: text,
        created_at: new Date().toISOString(),
      });

      // Get AI response
      if (!conv.bot_paused) {
        const history = data.messages
          .filter(m => m.conversation_id === conv.id)
          .slice(-10)
          .map(m => ({
            role: m.sender === 'user' ? 'user' : 'assistant',
            content: m.message,
          }));

        history.push({ role: 'user', content: text });

        try {
          const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: history,
            max_tokens: 500,
          });

          const aiText = response.choices[0].message.content;

          // Save AI message
          data.messages.push({
            id: (data.messages.length > 0 ? Math.max(...data.messages.map(m => m.id)) : 0) + 1,
            conversation_id: conv.id,
            sender: 'assistant',
            message: aiText,
            created_at: new Date().toISOString(),
          });

          // Send to WhatsApp
          await axios.post(
            `https://graph.instagram.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
            {
              messaging_product: 'whatsapp',
              recipient_type: 'individual',
              to: phone,
              type: 'text',
              text: { body: aiText },
            },
            { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` } }
          );
        } catch (err) {
          console.error('AI error:', err.message);
        }
      }

      saveData();
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500);
  }
});

// API: Get conversations
app.get('/api/conversations', (req, res) => {
  const convs = data.conversations.map(c => ({
    ...c,
    message_count: data.messages.filter(m => m.conversation_id === c.id).length,
  }));
  res.json(convs);
});

// API: Get messages
app.get('/api/conversations/:id/messages', (req, res) => {
  const messages = data.messages.filter(m => m.conversation_id === parseInt(req.params.id));
  res.json(messages);
});

// API: Pause/resume
app.post('/api/conversations/:id/pause', (req, res) => {
  const conv = data.conversations.find(c => c.id === parseInt(req.params.id));
  if (conv) {
    conv.bot_paused = req.body.paused ? 1 : 0;
    saveData();
  }
  res.json({ success: true });
});

// API: Send message
app.post('/api/conversations/:id/send', async (req, res) => {
  const conv = data.conversations.find(c => c.id === parseInt(req.params.id));
  if (!conv) return res.status(404).json({ error: 'Not found' });

  try {
    await axios.post(
      `https://graph.instagram.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: conv.phone_number,
        type: 'text',
        text: { body: req.body.message },
      },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` } }
    );

    data.messages.push({
      id: (data.messages.length > 0 ? Math.max(...data.messages.map(m => m.id)) : 0) + 1,
      conversation_id: conv.id,
      sender: 'agent',
      message: req.body.message,
      created_at: new Date().toISOString(),
    });
    saveData();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: Reports
app.get('/api/reports', (req, res) => {
  res.json({
    totalConversations: data.conversations.length,
    totalMessages: data.messages.length,
    activeConversations: data.conversations.filter(c => c.status === 'active').length,
    messagesByDay: [],
  });
});

app.listen(3000, '0.0.0.0', () => {
  console.log('✅ Server started on port 3000');
});
