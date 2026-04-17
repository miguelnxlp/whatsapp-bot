const supabase = require('./_lib/supabase');

module.exports = async (req, res) => {
  try {
    const { id } = req.query;

    const { data: messages } = await supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', parseInt(id))
      .order('created_at', { ascending: true });

    res.status(200).json(messages || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
