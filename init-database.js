const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

// Database file path
const DB_PATH = path.join(__dirname, 'isn_wifi.db');

// Create database and tables
function initializeDatabase() {
  console.log('Initializing SQLite database...');
  
  const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
      console.error('Error opening database:', err.message);
      return;
    }
    console.log('Connected to SQLite database');
  });

  // Create tables
  db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      phone TEXT UNIQUE,
      password TEXT NOT NULL,
      firstName TEXT,
      surname TEXT,
      dob TEXT,
      dateCreatedISO TEXT,
      dateCreatedLocal TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Purchases/Bundles table with strict device tracking
    db.run(`CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      deviceId TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      bundleMB INTEGER NOT NULL,
      usedMB INTEGER DEFAULT 0,
      routerId TEXT,
      deviceUA TEXT,
      grantedAtISO TEXT,
      source TEXT,
      strictMode INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX(identifier),
      INDEX(deviceId),
      INDEX(identifier, deviceId)
    )`);

    // Sessions table
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      routerId TEXT,
      deviceUA TEXT,
      active INTEGER DEFAULT 1,
      startedAtISO TEXT,
      lastSeenISO TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX(identifier),
      INDEX(routerId),
      INDEX(active)
    )`);

    // Access log table
    db.run(`CREATE TABLE IF NOT EXISTS access_log (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      type TEXT NOT NULL,
      tsISO TEXT,
      ip TEXT,
      ua TEXT,
      changedFields TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX(identifier),
      INDEX(type),
      INDEX(tsISO)
    )`);

    // Ad events table
    db.run(`CREATE TABLE IF NOT EXISTS ad_events (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      adId TEXT NOT NULL,
      eventType TEXT NOT NULL,
      tsISO TEXT,
      routerId TEXT,
      watchSeconds INTEGER DEFAULT 0,
      deviceType TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX(identifier),
      INDEX(adId),
      INDEX(eventType),
      INDEX(tsISO)
    )`);

    // Routers table
    db.run(`CREATE TABLE IF NOT EXISTS routers (
      routerId TEXT PRIMARY KEY,
      ipAddress TEXT,
      location TEXT,
      lastMaintenanceISO TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Ads definition table
    db.run(`CREATE TABLE IF NOT EXISTS ads (
      adId TEXT PRIMARY KEY,
      title TEXT,
      type TEXT,
      routerZones TEXT,
      source TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    console.log('Database tables created successfully');
  });

  db.close((err) => {
    if (err) {
      console.error('Error closing database:', err.message);
    } else {
      console.log('Database setup complete');
    }
  });
}

if (require.main === module) {
  initializeDatabase();
}

module.exports = { initializeDatabase, DB_PATH };
