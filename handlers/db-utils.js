const { data, saveData } = require('../db');

function run(sql, params = []) {
  try {
    if (sql.includes('INSERT INTO conversations')) {
      const id = (data.conversations.length > 0 ? Math.max(...data.conversations.map(c => c.id)) : 0) + 1;
      const conversation = {
        id,
        phone_number: params[0],
        status: 'active',
        bot_paused: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      data.conversations.push(conversation);
      saveData();
      return { id };
    }

    if (sql.includes('INSERT INTO messages')) {
      const id = (data.messages.length > 0 ? Math.max(...data.messages.map(m => m.id)) : 0) + 1;
      const message = {
        id,
        conversation_id: params[0],
        sender: params[1],
        message: params[2],
        message_type: 'text',
        created_at: new Date().toISOString(),
      };
      data.messages.push(message);
      saveData();
      return { id };
    }

    if (sql.includes('UPDATE conversations SET bot_paused')) {
      const convId = params[1];
      const conv = data.conversations.find(c => c.id === convId);
      if (conv) {
        conv.bot_paused = params[0];
        conv.updated_at = new Date().toISOString();
        saveData();
      }
      return { changes: 1 };
    }

    return { changes: 0 };
  } catch (error) {
    console.error('DB run error:', error);
    throw error;
  }
}

function get(sql, params = []) {
  try {
    if (sql.includes('SELECT id FROM conversations WHERE phone_number')) {
      return data.conversations.find(c => c.phone_number === params[0]);
    }

    if (sql.includes('SELECT id, bot_paused FROM conversations WHERE phone_number')) {
      return data.conversations.find(c => c.phone_number === params[0]);
    }

    if (sql.includes('SELECT phone_number FROM conversations WHERE id')) {
      return data.conversations.find(c => c.id === params[0]);
    }

    if (sql.includes('SELECT COUNT(*) as count FROM conversations')) {
      if (sql.includes('WHERE status')) {
        return { count: data.conversations.filter(c => c.status === params[0]).length };
      }
      return { count: data.conversations.length };
    }

    if (sql.includes('SELECT COUNT(*) as count FROM messages')) {
      return { count: data.messages.length };
    }

    return null;
  } catch (error) {
    console.error('DB get error:', error);
    throw error;
  }
}

function all(sql, params = []) {
  try {
    if (sql.includes('SELECT sender, message FROM messages')) {
      return data.messages
        .filter(m => m.conversation_id === params[0])
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .slice(-10);
    }

    if (sql.includes('SELECT * FROM messages WHERE conversation_id')) {
      return data.messages
        .filter(m => m.conversation_id === params[0])
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }

    if (sql.includes('SELECT c.id, c.phone_number')) {
      return data.conversations
        .map(c => ({
          ...c,
          message_count: data.messages.filter(m => m.conversation_id === c.id).length,
        }))
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    }

    if (sql.includes('SELECT DATE(created_at)')) {
      const grouped = {};
      data.messages.forEach(m => {
        const date = m.created_at.split('T')[0];
        grouped[date] = (grouped[date] || 0) + 1;
      });
      return Object.entries(grouped)
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 7);
    }

    return [];
  } catch (error) {
    console.error('DB all error:', error);
    throw error;
  }
}

module.exports = { run, get, all };
