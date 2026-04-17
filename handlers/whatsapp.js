const axios = require('axios');
const db = require('../db');
const { getAIResponse } = require('./openai');

const WHATSAPP_API_URL = 'https://graph.instagram.com/v18.0';

async function sendMessage(phoneNumber, message) {
  try {
    const response = await axios.post(
      `${WHATSAPP_API_URL}/${process.env.WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phoneNumber,
        type: 'text',
        text: {
          body: message,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error('WhatsApp send error:', error.response?.data || error.message);
    throw error;
  }
}

async function handleIncomingMessage(phoneNumber, message) {
  try {
    let conv = db.prepare('SELECT id, bot_paused FROM conversations WHERE phone_number = ?').get(phoneNumber);

    if (!conv) {
      const result = db.prepare('INSERT INTO conversations (phone_number) VALUES (?)').run(phoneNumber);
      conv = { id: result.lastInsertRowid, bot_paused: 0 };
    }

    db.prepare(`
      INSERT INTO messages (conversation_id, sender, message)
      VALUES (?, ?, ?)
    `).run(conv.id, 'user', message);

    if (!conv.bot_paused) {
      const aiResponse = await getAIResponse(phoneNumber, message);
      await sendMessage(phoneNumber, aiResponse);
      db.prepare(`
        INSERT INTO messages (conversation_id, sender, message)
        VALUES (?, ?, ?)
      `).run(conv.id, 'assistant', aiResponse);
    }

    return { success: true, conversation_id: conv.id };
  } catch (error) {
    console.error('Incoming message error:', error);
    throw error;
  }
}

async function sendManualMessage(phoneNumber, message) {
  const result = await sendMessage(phoneNumber, message);
  const conv = db.prepare('SELECT id FROM conversations WHERE phone_number = ?').get(phoneNumber);
  if (conv) {
    db.prepare(`
      INSERT INTO messages (conversation_id, sender, message)
      VALUES (?, ?, ?)
    `).run(conv.id, 'agent', message);
  }
  return result;
}

module.exports = { sendMessage, handleIncomingMessage, sendManualMessage };
