const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'bot-data.json');

let data = {
  conversations: [],
  messages: [],
};

function loadData() {
  try {
    if (fs.existsSync(dbPath)) {
      const content = fs.readFileSync(dbPath, 'utf8');
      data = JSON.parse(content);
    }
  } catch (error) {
    console.error('Error loading data:', error);
  }
}

function saveData() {
  try {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error saving data:', error);
  }
}

loadData();
console.log('✅ Data store initialized');

module.exports = { data, saveData };
