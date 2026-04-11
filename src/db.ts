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

db.exec(`
  CREATE TABLE IF NOT EXISTS omnibus_pending_buys (
    client_order_id TEXT PRIMARY KEY,
    wallet_address TEXT NOT NULL,
    recipient_account_id TEXT NOT NULL,
    stock_id TEXT NOT NULL,
    payment_amount TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'awaiting_deposit',
    deposit_user_op_hash TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS omnibus_pending_sells (
    client_order_id TEXT PRIMARY KEY,
    wallet_address TEXT NOT NULL,
    recipient_account_id TEXT NOT NULL,
    stock_id TEXT NOT NULL,
    stock_token_address TEXT NOT NULL,
    asset_quantity TEXT NOT NULL,
    asset_decimals INTEGER NOT NULL DEFAULT 18,
    status TEXT NOT NULL DEFAULT 'awaiting_deposit',
    deposit_user_op_hash TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS omnibus_sell_accounting (
    client_order_id TEXT PRIMARY KEY,
    omnibus_account_id TEXT NOT NULL,
    recipient_account_id TEXT NOT NULL,
    order_request_id TEXT,
    order_id TEXT,
    sell_status TEXT,
    gross_payment_token_quantity TEXT,
    fee_payment_token_quantity TEXT,
    net_payment_token_quantity TEXT,
    payout_status TEXT NOT NULL DEFAULT 'not_requested',
    payout_withdrawal_request_id TEXT,
    payout_error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
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

export interface OmnibusPendingBuy {
  client_order_id: string;
  wallet_address: string;
  recipient_account_id: string;
  stock_id: string;
  payment_amount: string;
  status: string;
  deposit_user_op_hash: string | null;
  /** ISO string from insert; may be null on legacy rows */
  created_at: string | null;
}

export function insertOmnibusPendingBuy(row: {
  client_order_id: string;
  wallet_address: string;
  recipient_account_id: string;
  stock_id: string;
  payment_amount: string;
}): void {
  const createdAt = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO omnibus_pending_buys (client_order_id, wallet_address, recipient_account_id, stock_id, payment_amount, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'awaiting_deposit', ?)`,
  );
  stmt.run(
    row.client_order_id,
    row.wallet_address.toLowerCase(),
    row.recipient_account_id,
    row.stock_id,
    row.payment_amount,
    createdAt,
  );
}

export function getOmnibusPendingBuy(clientOrderId: string): OmnibusPendingBuy | undefined {
  const stmt = db.prepare('SELECT * FROM omnibus_pending_buys WHERE client_order_id = ?');
  return stmt.get(clientOrderId) as OmnibusPendingBuy | undefined;
}

export function updateOmnibusPendingBuy(
  clientOrderId: string,
  patch: Partial<Pick<OmnibusPendingBuy, 'status' | 'deposit_user_op_hash'>>,
): void {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const vals = keys.map((k) => patch[k]!);
  db.prepare(`UPDATE omnibus_pending_buys SET ${sets} WHERE client_order_id = ?`).run(
    ...vals,
    clientOrderId,
  );
}

export function listOmnibusPendingBuys(filters?: {
  wallet_address?: string;
  client_order_id?: string;
  limit?: number;
}): OmnibusPendingBuy[] {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (filters?.wallet_address) {
    where.push('wallet_address = ?');
    vals.push(filters.wallet_address.toLowerCase());
  }
  if (filters?.client_order_id) {
    where.push('client_order_id = ?');
    vals.push(filters.client_order_id);
  }
  const limit = Math.max(1, Math.min(filters?.limit ?? 50, 200));
  const sql =
    'SELECT * FROM omnibus_pending_buys' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY created_at DESC LIMIT ?';
  vals.push(limit);
  return db.prepare(sql).all(...vals) as OmnibusPendingBuy[];
}

export interface OmnibusPendingSell {
  client_order_id: string;
  wallet_address: string;
  recipient_account_id: string;
  stock_id: string;
  stock_token_address: string;
  asset_quantity: string;
  asset_decimals: number;
  status: string;
  deposit_user_op_hash: string | null;
  /** ISO string from insert; may be null on legacy rows */
  created_at: string | null;
}

export function insertOmnibusPendingSell(row: {
  client_order_id: string;
  wallet_address: string;
  recipient_account_id: string;
  stock_id: string;
  stock_token_address: string;
  asset_quantity: string;
  asset_decimals: number;
}): void {
  const createdAt = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO omnibus_pending_sells (
      client_order_id, wallet_address, recipient_account_id, stock_id,
      stock_token_address, asset_quantity, asset_decimals, status, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_deposit', ?)`,
  );
  stmt.run(
    row.client_order_id,
    row.wallet_address.toLowerCase(),
    row.recipient_account_id,
    row.stock_id,
    row.stock_token_address,
    row.asset_quantity,
    row.asset_decimals,
    createdAt,
  );
}

export function getOmnibusPendingSell(clientOrderId: string): OmnibusPendingSell | undefined {
  const stmt = db.prepare('SELECT * FROM omnibus_pending_sells WHERE client_order_id = ?');
  return stmt.get(clientOrderId) as OmnibusPendingSell | undefined;
}

export function updateOmnibusPendingSell(
  clientOrderId: string,
  patch: Partial<Pick<OmnibusPendingSell, 'status' | 'deposit_user_op_hash'>>,
): void {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const vals = keys.map((k) => patch[k]!);
  db.prepare(`UPDATE omnibus_pending_sells SET ${sets} WHERE client_order_id = ?`).run(
    ...vals,
    clientOrderId,
  );
}

export function listOmnibusPendingSells(filters?: {
  wallet_address?: string;
  client_order_id?: string;
  limit?: number;
}): OmnibusPendingSell[] {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (filters?.wallet_address) {
    where.push('wallet_address = ?');
    vals.push(filters.wallet_address.toLowerCase());
  }
  if (filters?.client_order_id) {
    where.push('client_order_id = ?');
    vals.push(filters.client_order_id);
  }
  const limit = Math.max(1, Math.min(filters?.limit ?? 50, 200));
  const sql =
    'SELECT * FROM omnibus_pending_sells' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY created_at DESC LIMIT ?';
  vals.push(limit);
  return db.prepare(sql).all(...vals) as OmnibusPendingSell[];
}

export interface OmnibusSellAccounting {
  client_order_id: string;
  omnibus_account_id: string;
  recipient_account_id: string;
  order_request_id: string | null;
  order_id: string | null;
  sell_status: string | null;
  gross_payment_token_quantity: string | null;
  fee_payment_token_quantity: string | null;
  net_payment_token_quantity: string | null;
  payout_status: string;
  payout_withdrawal_request_id: string | null;
  payout_error: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export function getOmnibusSellAccounting(clientOrderId: string): OmnibusSellAccounting | undefined {
  const stmt = db.prepare('SELECT * FROM omnibus_sell_accounting WHERE client_order_id = ?');
  return stmt.get(clientOrderId) as OmnibusSellAccounting | undefined;
}

export function upsertOmnibusSellAccounting(row: {
  client_order_id: string;
  omnibus_account_id: string;
  recipient_account_id: string;
  order_request_id?: string | null;
  order_id?: string | null;
  sell_status?: string | null;
  gross_payment_token_quantity?: string | null;
  fee_payment_token_quantity?: string | null;
  net_payment_token_quantity?: string | null;
  payout_status?: string;
  payout_withdrawal_request_id?: string | null;
  payout_error?: string | null;
}): void {
  const stmt = db.prepare(
    `INSERT INTO omnibus_sell_accounting (
      client_order_id, omnibus_account_id, recipient_account_id, order_request_id, order_id, sell_status,
      gross_payment_token_quantity, fee_payment_token_quantity, net_payment_token_quantity,
      payout_status, payout_withdrawal_request_id, payout_error, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_order_id) DO UPDATE SET
      omnibus_account_id=excluded.omnibus_account_id,
      recipient_account_id=excluded.recipient_account_id,
      order_request_id=excluded.order_request_id,
      order_id=excluded.order_id,
      sell_status=excluded.sell_status,
      gross_payment_token_quantity=excluded.gross_payment_token_quantity,
      fee_payment_token_quantity=excluded.fee_payment_token_quantity,
      net_payment_token_quantity=excluded.net_payment_token_quantity,
      payout_status=excluded.payout_status,
      payout_withdrawal_request_id=excluded.payout_withdrawal_request_id,
      payout_error=excluded.payout_error,
      updated_at=excluded.updated_at`,
  );
  stmt.run(
    row.client_order_id,
    row.omnibus_account_id,
    row.recipient_account_id,
    row.order_request_id ?? null,
    row.order_id ?? null,
    row.sell_status ?? null,
    row.gross_payment_token_quantity ?? null,
    row.fee_payment_token_quantity ?? null,
    row.net_payment_token_quantity ?? null,
    row.payout_status ?? 'not_requested',
    row.payout_withdrawal_request_id ?? null,
    row.payout_error ?? null,
    new Date().toISOString(),
  );
}

// ── Persona KYC (one row per app user reference-id, matches Persona reference-id) ──

db.exec(`
  CREATE TABLE IF NOT EXISTS persona_kyc (
    reference_id TEXT PRIMARY KEY,
    inquiry_id TEXT NOT NULL,
    status TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_persona_kyc_inquiry ON persona_kyc(inquiry_id);
`);

/** Aligns with Persona \`reference-id\` sent from the mobile app (e.g. Privy DID). */
export function normalizePersonaReferenceId(raw: string | undefined): string | undefined {
  if (raw == null || typeof raw !== 'string') return undefined;
  const t = raw.trim();
  return t.length > 0 ? t : undefined;
}

/** Best-effort: Persona status strings vary; treat approved/passed/completed as verified. */
export function inferPersonaVerified(status: string): number {
  const s = (status || '').toLowerCase();
  if (
    s.includes('approve') ||
    s.includes('passed') ||
    s.includes('completed') ||
    s.includes('success')
  ) {
    return 1;
  }
  return 0;
}

export interface PersonaKycRow {
  reference_id: string;
  inquiry_id: string;
  status: string;
  verified: number;
  updated_at: string;
}

export function upsertPersonaKyc(params: {
  referenceId: string;
  inquiryId: string;
  status: string;
  verified: number;
}): void {
  const stmt = db.prepare(`
    INSERT INTO persona_kyc (reference_id, inquiry_id, status, verified, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(reference_id) DO UPDATE SET
      inquiry_id = excluded.inquiry_id,
      status = excluded.status,
      verified = excluded.verified,
      updated_at = datetime('now')
  `);
  stmt.run(params.referenceId, params.inquiryId, params.status, params.verified);
}

export function getPersonaKycByReference(referenceId: string): PersonaKycRow | undefined {
  const stmt = db.prepare('SELECT * FROM persona_kyc WHERE reference_id = ?');
  return stmt.get(referenceId) as PersonaKycRow | undefined;
}

export function updatePersonaKycByInquiry(
  inquiryId: string,
  status: string,
  verified: number,
): boolean {
  const stmt = db.prepare(`
    UPDATE persona_kyc
    SET status = ?, verified = ?, updated_at = datetime('now')
    WHERE inquiry_id = ?
  `);
  return stmt.run(status, verified, inquiryId).changes > 0;
}

export default db;
