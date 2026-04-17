const supabase = require('./_lib/supabase');

module.exports = async (req, res) => {
  try {
    const { data: conversations } = await supabase
      .from('conversations')
      .select('*')
      .order('updated_at', { ascending: false });

    const result = [];
    for (const conv of conversations) {
      const { count } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('conversation_id', conv.id);

      result.push({
        ...conv,
        message_count: count || 0,
      });
    }

    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
