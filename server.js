require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { OpenAI } = require('openai');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const WA_API = `https://graph.facebook.com/v25.0/${process.env.WHATSAPP_PHONE_ID}`;
const WA_HEADERS = () => ({ Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` });

const DEFAULT_PROMPT = `Eres un asesor legal virtual especializado ÚNICAMENTE en contrato realidad en Colombia.

⚠️ RESTRICCIÓN IMPORTANTE:
- SOLO responde preguntas sobre CONTRATO REALIDAD
- Si el usuario pregunta sobre otros temas legales, responde: "Disculpa, solo estoy especializado en temas de contrato realidad. ¿Hay algo sobre tu situación laboral actual que quieras consultar?"
- NO des conceptos jurídicos genéricos
- NO hables sobre otros tipos de contrato, derecho penal, civil, etc.
- Si no es sobre contrato realidad, redirige amablemente

TONO:
- Formal pero cercano y empático
- Humano y conversacional
- Profesional pero accesible

FLUJO DE CONVERSACIÓN:
1. Saluda y pregunta el nombre si no lo sabes
2. Diagnostica si hay contrato realidad (pregunta sobre: horario fijo, jefe, subordinación, pago)
3. Explica sus derechos SI detectas contrato realidad
4. Ofrece agendar cita con abogado — cuando lo hagas, incluye al final exactamente: [OFRECER_CITA]
5. Si es necesario, pide datos para agendar

INFORMACIÓN ACTUAL:
- Fecha de hoy: {{today}}
- Horarios disponibles: Lunes-Jueves, 9:00 AM - 5:00 PM

CONTRATO REALIDAD - SOLO estos 3 elementos:
1. PRESTACIÓN PERSONAL: Tú personalmente haces el trabajo
2. SUBORDINACIÓN: Alguien te da órdenes, controla horarios
3. REMUNERACIÓN: Te pagan periódicamente`;

app.use(express.json());
app.use(express.static('public'));

// ── HELPERS ────────────────────────────────────────────────────────────────

async function getSystemPrompt() {
  try {
    const { data } = await supabase.from('bot_config').select('value').eq('key', 'system_prompt').single();
    const prompt = data?.value || DEFAULT_PROMPT;
    const today = new Date().toLocaleDateString('es-CO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    return prompt.replace('{{today}}', today);
  } catch {
    const today = new Date().toLocaleDateString('es-CO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    return DEFAULT_PROMPT.replace('{{today}}', today);
  }
}

async function transcribeAudio(mediaId) {
  const mediaInfo = await axios.get(`https://graph.facebook.com/v25.0/${mediaId}`, { headers: WA_HEADERS() });
  const audioRes = await axios.get(mediaInfo.data.url, { headers: WA_HEADERS(), responseType: 'arraybuffer' });
  const buffer = Buffer.from(audioRes.data);
  const { toFile } = await import('openai/uploads');
  const file = await toFile(buffer, 'audio.ogg', { type: 'audio/ogg' });
  const transcription = await openai.audio.transcriptions.create({ file, model: 'whisper-1', language: 'es' });
  return transcription.text;
}

async function sendTextMessage(phone, text) {
  return axios.post(`${WA_API}/messages`, {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'text',
    text: { body: text },
  }, { headers: WA_HEADERS() });
}

async function sendButtons(phone, bodyText) {
  return axios.post(`${WA_API}/messages`, {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'agendar_si', title: '📅 Sí, quiero agendar' } },
          { type: 'reply', reply: { id: 'agendar_no', title: 'No por ahora' } },
        ],
      },
    },
  }, { headers: WA_HEADERS() });
}

async function loadMemory(conversationId) {
  const { data } = await supabase.from('user_memory').select('*').eq('conversation_id', conversationId).single();
  return data || null;
}

function buildMemoryBlock(memory) {
  if (!memory) return '';
  const lines = [];
  if (memory.nombre) lines.push(`- Nombre: ${memory.nombre}`);
  if (memory.empresa) lines.push(`- Empresa/empleador: ${memory.empresa}`);
  if (memory.situacion) lines.push(`- Situación: ${memory.situacion}`);
  if (memory.notas) lines.push(`- Notas adicionales: ${memory.notas}`);
  if (!lines.length) return '';
  return `\nMEMORIA DEL USUARIO (usa esta info, no la vuelvas a preguntar):\n${lines.join('\n')}\n`;
}

async function updateMemory(conversationId, conversationText) {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Extrae información clave de esta conversación sobre contrato realidad.
Responde SOLO con JSON válido con estas claves (null si no se menciona):
{ "nombre": string|null, "empresa": string|null, "situacion": string|null, "notas": string|null }
- nombre: nombre del usuario
- empresa: empresa o empleador mencionado
- situacion: resumen breve de su caso laboral (max 100 chars)
- notas: cualquier dato extra relevante (horario, tiempo trabajando, salario, etc.)`
        },
        { role: 'user', content: conversationText }
      ],
      max_tokens: 200,
      temperature: 0,
    });

    const raw = res.choices[0].message.content.replace(/```json|```/g, '').trim();
    const extracted = JSON.parse(raw);

    const { data: existing } = await supabase.from('user_memory').select('*').eq('conversation_id', conversationId).single();
    const merged = {
      conversation_id: conversationId,
      nombre: extracted.nombre || existing?.nombre || null,
      empresa: extracted.empresa || existing?.empresa || null,
      situacion: extracted.situacion || existing?.situacion || null,
      notas: extracted.notas || existing?.notas || null,
      updated_at: new Date().toISOString(),
    };

    await supabase.from('user_memory').upsert(merged);
  } catch (e) {
    console.error('Memory update error:', e.message);
  }
}

async function getOrCreateConversation(phone) {
  let { data: conv, error } = await supabase.from('conversations').select('*').eq('phone_number', phone).single();
  if (error || !conv) {
    const { data: newConv, error: insertError } = await supabase.from('conversations').insert([{ phone_number: phone }]).select().single();
    if (insertError) throw insertError;
    conv = newConv;
  }
  return conv;
}

async function processMessage(phone, text, conv, messageType = 'text') {
  const { data: history } = await supabase.from('messages').select('*').eq('conversation_id', conv.id).order('created_at').limit(10);
  const displayText = messageType === 'audio' ? `🎤 [Audio transcrito]: ${text}` : text;
  await supabase.from('messages').insert([{ conversation_id: conv.id, sender: 'user', message: displayText }]);
  await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conv.id);

  if (conv.bot_paused) return;

  const [memory, systemPromptBase] = await Promise.all([
    loadMemory(conv.id),
    getSystemPrompt(),
  ]);

  const memoryBlock = buildMemoryBlock(memory);
  const systemPrompt = systemPromptBase + memoryBlock;

  const msgs = (history || []).map(m => ({ role: m.sender === 'user' ? 'user' : 'assistant', content: m.message }));
  msgs.push({ role: 'user', content: text });

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'system', content: systemPrompt }, ...msgs],
    max_tokens: 350,
    temperature: 0.7,
  });

  let aiText = response.choices[0].message.content;
  const offerCita = aiText.includes('[OFRECER_CITA]');
  aiText = aiText.replace('[OFRECER_CITA]', '').trim();

  await supabase.from('messages').insert([{ conversation_id: conv.id, sender: 'assistant', message: aiText }]);

  if (offerCita) {
    await sendButtons(phone, aiText);
  } else {
    await sendTextMessage(phone, aiText);
  }

  // Actualizar memoria en background (no bloquea la respuesta)
  const allText = [...msgs.map(m => `${m.role}: ${m.content}`), `assistant: ${aiText}`].join('\n');
  updateMemory(conv.id, allText);
}

// ── WEBHOOK ────────────────────────────────────────────────────────────────

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const messages = req.body.entry?.[0]?.changes?.[0]?.value?.messages || [];
    for (const msg of messages) {
      const phone = msg.from;
      console.log(`📱 Mensaje de ${phone} tipo: ${msg.type}`);

      try {
        const conv = await getOrCreateConversation(phone);

        if (msg.type === 'text') {
          await processMessage(phone, msg.text.body, conv, 'text');

        } else if (msg.type === 'audio' || msg.type === 'voice') {
          console.log(`🎤 Transcribiendo audio de ${phone}...`);
          await sendTextMessage(phone, '🎤 Recibí tu audio, un momento...');
          const transcription = await transcribeAudio(msg.audio?.id || msg.voice?.id);
          console.log(`📝 Transcripción: ${transcription}`);
          await processMessage(phone, transcription, conv, 'audio');

        } else if (msg.type === 'interactive') {
          const buttonId = msg.interactive?.button_reply?.id;
          const buttonTitle = msg.interactive?.button_reply?.title;
          if (buttonId === 'agendar_si') {
            await processMessage(phone, 'Sí, quiero agendar una cita', conv, 'text');
          } else if (buttonId === 'agendar_no') {
            await processMessage(phone, 'No quiero agendar por ahora', conv, 'text');
          } else {
            await processMessage(phone, buttonTitle || 'Respuesta seleccionada', conv, 'text');
          }
        }
      } catch (err) {
        console.error(`❌ Error procesando mensaje de ${phone}:`, err.response?.data || err.message);
      }
    }
  } catch (error) {
    console.error('Webhook error:', error);
  }
});

// ── APIS CONVERSACIONES ────────────────────────────────────────────────────

app.get('/api/conversations', async (req, res) => {
  try {
    const { data: conversations } = await supabase
      .from('conversations')
      .select('*, messages(count)')
      .order('updated_at', { ascending: false });
    const result = (conversations || []).map(c => ({
      ...c,
      message_count: c.messages?.[0]?.count || 0,
      messages: undefined,
    }));
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
    await sendTextMessage(conv.phone_number, req.body.message);
    await supabase.from('messages').insert([{ conversation_id: conv.id, sender: 'agent', message: req.body.message }]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reports', async (req, res) => {
  try {
    const [{ count: totalConversations }, { count: totalMessages }] = await Promise.all([
      supabase.from('conversations').select('*', { count: 'exact', head: true }),
      supabase.from('messages').select('*', { count: 'exact', head: true }),
    ]);
    res.json({ totalConversations: totalConversations || 0, totalMessages: totalMessages || 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/conversations/:id/memory', async (req, res) => {
  try {
    const { data } = await supabase.from('user_memory').select('*').eq('conversation_id', parseInt(req.params.id)).single();
    res.json(data || {});
  } catch (error) {
    res.json({});
  }
});

// ── API CONFIG PROMPT ──────────────────────────────────────────────────────

app.get('/api/config/prompt', async (req, res) => {
  try {
    const { data } = await supabase.from('bot_config').select('value').eq('key', 'system_prompt').single();
    res.json({ prompt: data?.value || DEFAULT_PROMPT });
  } catch {
    res.json({ prompt: DEFAULT_PROMPT });
  }
});

app.post('/api/config/prompt', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt requerido' });
    await supabase.from('bot_config').upsert({ key: 'system_prompt', value: prompt, updated_at: new Date().toISOString() });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));
