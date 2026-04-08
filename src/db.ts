import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(__dirname, '..', 'dinari.db');

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS dinari_users (
    wallet_address TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

export interface DinariUser {
  wallet_address: string;
  entity_id: string;
  account_id: string;
  created_at: string;
}

export function getUserByWallet(walletAddress: string): DinariUser | undefined {
  const stmt = db.prepare('SELECT * FROM dinari_users WHERE wallet_address = ?');
  return stmt.get(walletAddress.toLowerCase()) as DinariUser | undefined;
}

export function saveUser(walletAddress: string, entityId: string, accountId: string): void {
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO dinari_users (wallet_address, entity_id, account_id) VALUES (?, ?, ?)'
  );
  stmt.run(walletAddress.toLowerCase(), entityId, accountId);
}

export function deleteUser(walletAddress: string): void {
  const stmt = db.prepare('DELETE FROM dinari_users WHERE wallet_address = ?');
  stmt.run(walletAddress.toLowerCase());
}

export default db;
