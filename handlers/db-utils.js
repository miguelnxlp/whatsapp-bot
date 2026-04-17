const { getDB, saveDB } = require('../db');

function run(sql, params = []) {
  const db = getDB();
  try {
    db.run(sql, params);
    saveDB();
    return { id: db.getRowsModified(), changes: db.getRowsModified() };
  } catch (error) {
    console.error('DB run error:', error);
    throw error;
  }
}

function get(sql, params = []) {
  const db = getDB();
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return null;
  } catch (error) {
    console.error('DB get error:', error);
    throw error;
  }
}

function all(sql, params = []) {
  const db = getDB();
  try {
    const rows = [];
    const stmt = db.prepare(sql);
    stmt.bind(params);
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  } catch (error) {
    console.error('DB all error:', error);
    throw error;
  }
}

module.exports = { run, get, all };
