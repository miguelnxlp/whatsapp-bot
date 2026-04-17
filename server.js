require('dotenv').config();
console.log('1. Env loaded');

const express = require('express');
console.log('2. Express loaded');

const cors = require('cors');
console.log('3. CORS loaded');

const app = express();
console.log('4. Express app created');

app.use(cors());
app.use(express.json());
app.use(express.static('public'));
console.log('5. Middleware added');

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'WhatsApp Bot is running' });
});

app.get('/webhook', (req, res) => {
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (token === process.env.VERIFY_TOKEN) {
    res.send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', (req, res) => {
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
console.log('6. Starting server on port', PORT);

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

console.log('7. Server initialized');
