const sqlite3 = require('sqlite3-offline-next');
const path = require('path');

const dbPath = path.join(__dirname, '../data/automation.db');
const db = new sqlite3.Database(dbPath);

//====================================================
//CLIENT TABLE CREATION
//====================================================
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_name TEXT,
      client_code TEXT,
      entity_code TEXT,
      month TEXT,
      file_path TEXT,
      status TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) {
      console.error("❌ Table creation failed:", err.message);
    } else {
      console.log("✅ clients table created");
    }
  });

  db.all("PRAGMA table_info(clients)", (err, columns) => {
    if (err) {
      console.error("Could not inspect clients table:", err.message);
      return;
    }

    const hasClientName = columns.some((column) => column.name === "client_name");
    if (!hasClientName) {
      db.run("ALTER TABLE clients ADD COLUMN client_name TEXT", (alterErr) => {
        if (alterErr) console.error("Could not add client_name column:", alterErr.message);
      });
    }
  });
});

module.exports = db;
