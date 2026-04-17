const { OpenAI } = require('openai');
const { get, all } = require('./db-utils');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function getAIResponse(phoneNumber, message) {
  try {
    const conv = await get('SELECT id FROM conversations WHERE phone_number = ?', [phoneNumber]);
    if (!conv) return null;

    const messages = await all(`
      SELECT sender, message FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at DESC LIMIT 10
    `, [conv.id]);

    const conversationHistory = messages.reverse().map(msg => ({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.message,
    }));

    conversationHistory.push({
      role: 'user',
      content: message,
    });

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: conversationHistory,
      max_tokens: 500,
      temperature: 0.7,
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error('OpenAI error:', error);
    return 'Disculpa, tuve un error. Intenta de nuevo.';
  }
}

module.exports = { getAIResponse };
