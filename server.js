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

TONO: Formal pero cercano y empático. Humano y conversacional. Profesional pero accesible.

FLUJO:
1. Saluda y pregunta el nombre si no lo sabes
2. Diagnostica si hay contrato realidad (horario fijo, jefe, subordinación, pago)
3. Explica sus derechos SI detectas contrato realidad
4. Ofrece agendar cita — incluye [OFRECER_CITA] al final cuando lo hagas
5. Pide datos para agendar si es necesario

INFORMACIÓN ACTUAL:
- Fecha de hoy: {{today}}
- Horarios disponibles: Lunes-Jueves, 9:00 AM - 5:00 PM

CONTRATO REALIDAD:
1. PRESTACIÓN PERSONAL: Tú personalmente haces el trabajo
2. SUBORDINACIÓN: Alguien te da órdenes, controla horarios
3. REMUNERACIÓN: Te pagan periódicamente`;

app.use(express.json());

// ── BASIC AUTH (protects dashboard + API, exempts webhook) ─────────────────
app.use((req, res, next) => {
  if (req.path === '/webhook' || req.path.startsWith('/webhook')) return next();
  const user = process.env.DASHBOARD_USER || 'admin';
  const pass = process.env.DASHBOARD_PASS || 'botlegal2024';
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Bot Legal"');
    return res.status(401).send('Autenticación requerida');
  }
  const [u, p] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  if (u !== user || p !== pass) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Bot Legal"');
    return res.status(401).send('Credenciales incorrectas');
  }
  next();
});

app.use(express.static('public'));

// ── CONFIG HELPERS ─────────────────────────────────────────────────────────

async function getConfig(key, fallback = null) {
  try {
    const { data } = await supabase.from('bot_config').select('value').eq('key', key).single();
    return data?.value ?? fallback;
  } catch { return fallback; }
}

async function getAllConfig() {
  try {
    const { data } = await supabase.from('bot_config').select('key, value');
    const cfg = {};
    (data || []).forEach(row => { cfg[row.key] = row.value; });
    return cfg;
  } catch { return {}; }
}

async function setConfig(key, value) {
  await supabase.from('bot_config').upsert({ key, value, updated_at: new Date().toISOString() });
}

function buildSystemPrompt(rawPrompt) {
  const prompt = rawPrompt || DEFAULT_PROMPT;
  const today = new Date().toLocaleDateString('es-CO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return prompt.replace('{{today}}', today);
}

async function getSystemPrompt() {
  const raw = await getConfig('system_prompt', null);
  return buildSystemPrompt(raw);
}

function isWithinBusinessHours(hoursConfig) {
  if (!hoursConfig) return true;
  try {
    const hours = JSON.parse(hoursConfig);
    const now = new Date();
    const day = now.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const slot = hours[day];
    if (!slot || !slot.enabled) return false;
    const [startH, startM] = slot.start.split(':').map(Number);
    const [endH, endM] = slot.end.split(':').map(Number);
    const current = now.getHours() * 60 + now.getMinutes();
    return current >= startH * 60 + startM && current <= endH * 60 + endM;
  } catch { return true; }
}

// ── WA HELPERS ─────────────────────────────────────────────────────────────

async function markAsRead(messageId) {
  try {
    await axios.post(`${WA_API}/messages`, {
      messaging_product: 'whatsapp', status: 'read', message_id: messageId,
    }, { headers: WA_HEADERS() });
  } catch {}
}

async function sendTypingOn(phone) {
  try {
    await axios.post(`${WA_API}/messages`, {
      messaging_product: 'whatsapp', to: phone, recipient_type: 'individual',
      type: 'text', status: 'typing',
    }, { headers: WA_HEADERS() });
  } catch {}
  await new Promise(r => setTimeout(r, 1200 + Math.floor(Math.random() * 800)));
}

async function sendTextMessage(phone, text) {
  const res = await axios.post(`${WA_API}/messages`, {
    messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: text },
  }, { headers: WA_HEADERS() });
  return res.data?.messages?.[0]?.id || null;
}

async function sendButtons(phone, bodyText) {
  const res = await axios.post(`${WA_API}/messages`, {
    messaging_product: 'whatsapp', to: phone, type: 'interactive',
    interactive: {
      type: 'button', body: { text: bodyText },
      action: { buttons: [
        { type: 'reply', reply: { id: 'agendar_si', title: '📅 Sí, quiero agendar' } },
        { type: 'reply', reply: { id: 'agendar_no', title: 'No por ahora' } },
      ]},
    },
  }, { headers: WA_HEADERS() });
  return res.data?.messages?.[0]?.id || null;
}

async function transcribeAudio(mediaId) {
  const mediaInfo = await axios.get(`https://graph.facebook.com/v25.0/${mediaId}`, { headers: WA_HEADERS() });
  const audioRes = await axios.get(mediaInfo.data.url, { headers: WA_HEADERS(), responseType: 'arraybuffer' });
  const { toFile } = await import('openai/uploads');
  const file = await toFile(Buffer.from(audioRes.data), 'audio.ogg', { type: 'audio/ogg' });
  const transcription = await openai.audio.transcriptions.create({ file, model: 'gpt-4o-mini-transcribe', language: 'es' });
  return transcription.text;
}

// ── MEMORY HELPERS ─────────────────────────────────────────────────────────

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
  return `\nMEMORIA DEL USUARIO (no vuelvas a preguntar estos datos):\n${lines.join('\n')}\n`;
}

async function updateMemory(conversationId, conversationText) {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4.1-nano',
      messages: [
        { role: 'system', content: `Extrae info clave. Responde SOLO JSON: { "nombre": string|null, "empresa": string|null, "situacion": string|null, "notas": string|null }` },
        { role: 'user', content: conversationText }
      ],
      max_tokens: 150, temperature: 0,
    });
    const raw = res.choices[0].message.content.replace(/```json|```/g, '').trim();
    const extracted = JSON.parse(raw);
    const { data: existing } = await supabase.from('user_memory').select('*').eq('conversation_id', conversationId).single();
    await supabase.from('user_memory').upsert({
      conversation_id: conversationId,
      nombre: extracted.nombre || existing?.nombre || null,
      empresa: extracted.empresa || existing?.empresa || null,
      situacion: extracted.situacion || existing?.situacion || null,
      notas: extracted.notas || existing?.notas || null,
      updated_at: new Date().toISOString(),
    });
  } catch (e) { console.error('Memory error:', e.message); }
}

// ── CONVERSATION HELPERS ───────────────────────────────────────────────────

async function getOrCreateConversation(phone) {
  let { data: conv, error } = await supabase.from('conversations').select('*').eq('phone_number', phone).single();
  if (error || !conv) {
    const { data: newConv, error: insertError } = await supabase.from('conversations').insert([{ phone_number: phone, status: 'active' }]).select().single();
    if (insertError) throw insertError;
    conv = newConv;

    const welcome = await getConfig('welcome_message');
    if (welcome) {
      await sendTextMessage(phone, welcome);
      await supabase.from('messages').insert([{ conversation_id: newConv.id, sender: 'assistant', message: welcome }]);
    }
  }
  return conv;
}

async function processMessage(phone, text, conv, messageType = 'text') {
  const { data: history } = await supabase.from('messages').select('*').eq('conversation_id', conv.id).order('created_at').limit(15);
  const displayText = messageType === 'audio' ? `🎤 [Audio]: ${text}` : text;
  await supabase.from('messages').insert([{ conversation_id: conv.id, sender: 'user', message: displayText }]);
  await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conv.id);

  if (conv.bot_paused) return;

  // Carga config + memoria en paralelo (1 query a bot_config en lugar de 4 secuenciales)
  const [cfg, memory] = await Promise.all([getAllConfig(), loadMemory(conv.id)]);

  if ((cfg.bot_paused_global || 'false') === 'true') {
    await sendTextMessage(phone, cfg.paused_message || 'Estamos fuera de servicio temporalmente. Te contactaremos pronto.');
    return;
  }

  if (cfg.business_hours && !isWithinBusinessHours(cfg.business_hours)) {
    await sendTextMessage(phone, cfg.off_hours_message || 'Gracias por escribirnos. Nuestro horario es Lunes-Jueves 9am-5pm. Te responderemos pronto.');
    return;
  }

  if (cfg.handoff_keywords) {
    const keywords = cfg.handoff_keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    if (keywords.some(k => text.toLowerCase().includes(k))) {
      await supabase.from('conversations').update({ bot_paused: 1, updated_at: new Date().toISOString() }).eq('id', conv.id);
      await sendTextMessage(phone, 'Un momento, te estoy conectando con un asesor humano.');
      return;
    }
  }

  const systemPrompt = buildSystemPrompt(cfg.system_prompt) + buildMemoryBlock(memory);
  const msgs = (history || []).map(m => ({ role: m.sender === 'user' ? 'user' : 'assistant', content: m.message }));
  msgs.push({ role: 'user', content: text });

  await sendTypingOn(phone);

  const response = await openai.chat.completions.create({
    model: 'gpt-4.1-nano',
    messages: [{ role: 'system', content: systemPrompt }, ...msgs],
    max_tokens: 350, temperature: 0.7,
  });

  let aiText = response.choices[0].message.content;
  const offerCita = aiText.includes('[OFRECER_CITA]');
  aiText = aiText.replace('[OFRECER_CITA]', '').trim();

  const waId = offerCita ? await sendButtons(phone, aiText) : await sendTextMessage(phone, aiText);
  await supabase.from('messages').insert([{ conversation_id: conv.id, sender: 'assistant', message: aiText, wa_message_id: waId, delivery_status: 'sent' }]);

  const allText = [...msgs.map(m => `${m.role}: ${m.content}`), `assistant: ${aiText}`].join('\n');
  updateMemory(conv.id, allText);
}

// ── WEBHOOK ────────────────────────────────────────────────────────────────

app.get('/webhook', (req, res) => {
  req.query['hub.verify_token'] === process.env.VERIFY_TOKEN ? res.send(req.query['hub.challenge']) : res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value || {};

    // Delivery status updates (sent → delivered → read)
    const statuses = value.statuses || [];
    for (const s of statuses) {
      await supabase.from('messages').update({ delivery_status: s.status }).eq('wa_message_id', s.id);
    }

    const messages = value.messages || [];
    for (const msg of messages) {
      const phone = msg.from;
      try {
        markAsRead(msg.id); // fire-and-forget: show blue ticks to user
        const conv = await getOrCreateConversation(phone);
        if (msg.type === 'text') {
          await processMessage(phone, msg.text.body, conv, 'text');
        } else if (msg.type === 'audio' || msg.type === 'voice') {
          await sendTextMessage(phone, '🎤 Recibí tu audio, un momento...');
          const transcription = await transcribeAudio(msg.audio?.id || msg.voice?.id);
          await processMessage(phone, transcription, conv, 'audio');
        } else if (msg.type === 'interactive') {
          const id = msg.interactive?.button_reply?.id;
          const text = id === 'agendar_si' ? 'Sí, quiero agendar una cita' : id === 'agendar_no' ? 'No quiero agendar por ahora' : msg.interactive?.button_reply?.title;
          await processMessage(phone, text, conv, 'text');
        }
      } catch (err) {
        console.error(`❌ Error ${phone}:`, err.response?.data || err.message);
      }
    }
  } catch (error) { console.error('Webhook error:', error); }
});

// ── CONVERSACIONES ─────────────────────────────────────────────────────────

app.get('/api/conversations', async (req, res) => {
  try {
    const { status } = req.query;
    let query = supabase.from('conversations').select('*, messages(count)').order('updated_at', { ascending: false });
    if (status && status !== 'all') query = query.eq('status', status);
    const { data } = await query;
    res.json((data || []).map(c => ({ ...c, message_count: c.messages?.[0]?.count || 0, messages: undefined })));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/conversations/:id/messages', async (req, res) => {
  try {
    const { data } = await supabase.from('messages').select('*').eq('conversation_id', parseInt(req.params.id)).order('created_at');
    res.json(data || []);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/conversations/:id/pause', async (req, res) => {
  try {
    await supabase.from('conversations').update({ bot_paused: req.body.paused ? 1 : 0 }).eq('id', parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/conversations/:id/resolve', async (req, res) => {
  try {
    await supabase.from('conversations').update({ status: 'resolved', resolved_at: new Date().toISOString() }).eq('id', parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/conversations/:id/tags', async (req, res) => {
  try {
    await supabase.from('conversations').update({ tags: req.body.tags }).eq('id', parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/conversations/:id/send', async (req, res) => {
  try {
    const { data: conv } = await supabase.from('conversations').select('*').eq('id', parseInt(req.params.id)).single();
    if (!conv) return res.status(404).json({ error: 'Not found' });
    const waId = await sendTextMessage(conv.phone_number, req.body.message);
    await supabase.from('messages').insert([{ conversation_id: conv.id, sender: 'agent', message: req.body.message, wa_message_id: waId, delivery_status: 'sent' }]);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/conversations/:id/memory', async (req, res) => {
  try {
    const { data } = await supabase.from('user_memory').select('*').eq('conversation_id', parseInt(req.params.id)).single();
    res.json(data || {});
  } catch { res.json({}); }
});

// ── CONTACTOS ──────────────────────────────────────────────────────────────

app.get('/api/contacts', async (req, res) => {
  try {
    const { data } = await supabase.from('user_memory').select('*, conversations(phone_number, updated_at, status, bot_paused)').order('updated_at', { ascending: false });
    res.json(data || []);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── MÉTRICAS ───────────────────────────────────────────────────────────────

app.get('/api/metrics', async (req, res) => {
  try {
    const [{ count: totalConvs }, { count: totalMsgs }, { data: recent }] = await Promise.all([
      supabase.from('conversations').select('*', { count: 'exact', head: true }),
      supabase.from('messages').select('*', { count: 'exact', head: true }),
      supabase.from('messages').select('created_at').gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString()),
    ]);

    const byDay = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric' });
      byDay[d] = 0;
    }
    (recent || []).forEach(m => {
      const d = new Date(m.created_at).toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric' });
      if (byDay[d] !== undefined) byDay[d]++;
    });

    const { count: resolved } = await supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('status', 'resolved');
    const { count: withAgent } = await supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('bot_paused', 1);

    res.json({
      totalConversations: totalConvs || 0,
      totalMessages: totalMsgs || 0,
      resolved: resolved || 0,
      withAgent: withAgent || 0,
      msgsByDay: byDay,
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── QUICK REPLIES ──────────────────────────────────────────────────────────

app.get('/api/quick-replies', async (req, res) => {
  try {
    const { data } = await supabase.from('quick_replies').select('*').order('created_at');
    res.json(data || []);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/quick-replies', async (req, res) => {
  try {
    const { title, message } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'title y message requeridos' });
    const { data } = await supabase.from('quick_replies').insert([{ title, message }]).select().single();
    res.json(data);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/quick-replies/:id', async (req, res) => {
  try {
    await supabase.from('quick_replies').delete().eq('id', parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── CONFIG ─────────────────────────────────────────────────────────────────

app.get('/api/config', async (req, res) => {
  try {
    const { data } = await supabase.from('bot_config').select('*');
    const config = {};
    (data || []).forEach(row => { config[row.key] = row.value; });
    res.json(config);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/config', async (req, res) => {
  try {
    const entries = Object.entries(req.body);
    for (const [key, value] of entries) {
      await setConfig(key, value);
    }
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── EXPORT CSV ─────────────────────────────────────────────────────────────

app.get('/api/conversations/export/csv', async (req, res) => {
  try {
    const { data: convs } = await supabase.from('conversations').select('*').order('updated_at', { ascending: false });
    const rows = [['ID', 'Teléfono', 'Estado', 'Bot Pausado', 'Tags', 'Creado', 'Actualizado']];
    (convs || []).forEach(c => rows.push([c.id, c.phone_number, c.status, c.bot_paused ? 'Sí' : 'No', c.tags || '', c.created_at, c.updated_at]));
    const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="conversaciones.csv"');
    res.send(csv);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));
