const axios = require('axios');
const { run, get } = require('./db-utils');
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
    let conv = await get('SELECT id, bot_paused FROM conversations WHERE phone_number = ?', [phoneNumber]);

    if (!conv) {
      const result = await run('INSERT INTO conversations (phone_number) VALUES (?)', [phoneNumber]);
      conv = { id: result.id, bot_paused: 0 };
    }

    await run(
      `INSERT INTO messages (conversation_id, sender, message) VALUES (?, ?, ?)`,
      [conv.id, 'user', message]
    );

    if (!conv.bot_paused) {
      const aiResponse = await getAIResponse(phoneNumber, message);
      if (aiResponse) {
        await sendMessage(phoneNumber, aiResponse);
        await run(
          `INSERT INTO messages (conversation_id, sender, message) VALUES (?, ?, ?)`,
          [conv.id, 'assistant', aiResponse]
        );
      }
    }

    return { success: true, conversation_id: conv.id };
  } catch (error) {
    console.error('Incoming message error:', error);
    throw error;
  }
}

async function sendManualMessage(phoneNumber, message) {
  const result = await sendMessage(phoneNumber, message);
  const conv = await get('SELECT id FROM conversations WHERE phone_number = ?', [phoneNumber]);
  if (conv) {
    await run(
      `INSERT INTO messages (conversation_id, sender, message) VALUES (?, ?, ?)`,
      [conv.id, 'agent', message]
    );
  }
  return result;
}

module.exports = { sendMessage, handleIncomingMessage, sendManualMessage };
