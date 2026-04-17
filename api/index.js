const fs = require('fs');
const path = require('path');

module.exports = (req, res) => {
  const htmlPath = path.join(__dirname, '../public/index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(html);
};
