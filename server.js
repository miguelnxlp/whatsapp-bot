require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { OpenAI } = require('openai');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.json());
app.use(express.static('public'));

// Webhook
app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  try {
    const messages = req.body.entry?.[0]?.changes?.[0]?.value?.messages || [];

    for (const msg of messages) {
      const phone = msg.from;
      const text = msg.text?.body;
      if (!text) continue;

      let { data: conv } = await supabase.from('conversations').select('*').eq('phone_number', phone).single();
      if (!conv) {
        const { data: newConv } = await supabase.from('conversations').insert([{ phone_number: phone }]).select().single();
        conv = newConv;
      }

      await supabase.from('messages').insert([{ conversation_id: conv.id, sender: 'user', message: text }]);

      if (!conv.bot_paused) {
        const { data: history } = await supabase.from('messages').select('*').eq('conversation_id', conv.id).order('created_at').limit(10);
        const msgs = (history || []).map(m => ({ role: m.sender === 'user' ? 'user' : 'assistant', content: m.message }));
        msgs.push({ role: 'user', content: text });

        try {
          const response = await openai.chat.completions.create({ model: 'gpt-4o-mini', messages: msgs, max_tokens: 500 });
          const aiText = response.choices[0].message.content;

          await supabase.from('messages').insert([{ conversation_id: conv.id, sender: 'assistant', message: aiText }]);

          await axios.post(`https://graph.instagram.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
            messaging_product: 'whatsapp',
            to: phone,
            type: 'text',
            text: { body: aiText },
          }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` } });
        } catch (err) {
          console.error('AI error:', err.message);
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500);
  }
});

// APIs
app.get('/api/conversations', async (req, res) => {
  try {
    const { data: conversations } = await supabase.from('conversations').select('*').order('updated_at', { ascending: false });
    const result = [];
    for (const conv of conversations || []) {
      const { count } = await supabase.from('messages').select('*', { count: 'exact', head: true }).eq('conversation_id', conv.id);
      result.push({ ...conv, message_count: count || 0 });
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/conversations/:id/messages', async (req, res) => {
  try {
    const { data: messages } = await supabase.from('messages').select('*').eq('conversation_id', parseInt(req.params.id)).order('created_at');
    res.json(messages || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/conversations/:id/pause', async (req, res) => {
  try {
    await supabase.from('conversations').update({ bot_paused: req.body.paused ? 1 : 0 }).eq('id', parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/conversations/:id/send', async (req, res) => {
  try {
    const { data: conv } = await supabase.from('conversations').select('*').eq('id', parseInt(req.params.id)).single();
    if (!conv) return res.status(404).json({ error: 'Not found' });

    await axios.post(`https://graph.instagram.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      messaging_product: 'whatsapp',
      to: conv.phone_number,
      type: 'text',
      text: { body: req.body.message },
    }, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` } });

    await supabase.from('messages').insert([{ conversation_id: conv.id, sender: 'agent', message: req.body.message }]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports', async (req, res) => {
  try {
    const { data: conversations } = await supabase.from('conversations').select('*');
    const { data: messages } = await supabase.from('messages').select('*');
    res.json({
      totalConversations: conversations?.length || 0,
      totalMessages: messages?.length || 0,
      activeConversations: conversations?.filter(c => c.status === 'active').length || 0,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));
