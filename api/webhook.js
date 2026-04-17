const axios = require('axios');
const { OpenAI } = require('openai');
const supabase = require('./_lib/supabase');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

module.exports = async (req, res) => {
  // Webhook verification
  if (req.method === 'GET') {
    if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
      return res.status(200).send(req.query['hub.challenge']);
    }
    return res.status(403).send('Forbidden');
  }

  // Receive messages
  if (req.method === 'POST') {
    try {
      const messages = req.body.entry?.[0]?.changes?.[0]?.value?.messages || [];

      for (const msg of messages) {
        const phone = msg.from;
        const text = msg.text?.body;

        if (!text) continue;

        // Find or create conversation
        let { data: conv, error } = await supabase
          .from('conversations')
          .select('*')
          .eq('phone_number', phone)
          .single();

        if (error) {
          // Create new conversation
          const { data: newConv } = await supabase
            .from('conversations')
            .insert([{ phone_number: phone }])
            .select()
            .single();
          conv = newConv;
        }

        // Save user message
        await supabase.from('messages').insert([
          {
            conversation_id: conv.id,
            sender: 'user',
            message: text,
          },
        ]);

        // Get AI response
        if (!conv.bot_paused) {
          const { data: history } = await supabase
            .from('messages')
            .select('*')
            .eq('conversation_id', conv.id)
            .order('created_at', { ascending: true })
            .range(0, 9);

          const messages_formatted = history.map(m => ({
            role: m.sender === 'user' ? 'user' : 'assistant',
            content: m.message,
          }));

          messages_formatted.push({ role: 'user', content: text });

          try {
            const response = await openai.chat.completions.create({
              model: 'gpt-4o-mini',
              messages: messages_formatted,
              max_tokens: 500,
            });

            const aiText = response.choices[0].message.content;

            // Save AI message
            await supabase.from('messages').insert([
              {
                conversation_id: conv.id,
                sender: 'assistant',
                message: aiText,
              },
            ]);

            // Send to WhatsApp
            await axios.post(
              `https://graph.instagram.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
              {
                messaging_product: 'whatsapp',
                to: phone,
                type: 'text',
                text: { body: aiText },
              },
              {
                headers: {
                  Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
                },
              }
            );
          } catch (err) {
            console.error('AI error:', err.message);
          }
        }
      }

      res.status(200).json({ success: true });
    } catch (error) {
      console.error('Webhook error:', error);
      res.status(500).json({ error: error.message });
    }
  }
};
