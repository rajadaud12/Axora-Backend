import { Router } from 'express';
import Dinari from '@dinari/api-sdk';
import axios from 'axios';
import {
  getAddress,
  createPublicClient,
  http,
  formatUnits,
  parseUnits,
} from 'viem';
import { arbitrumSepolia, sepolia } from 'viem/chains';
import { getUserByWallet, saveUser, deleteUser } from '../db';
import {
  getSmartAccountAddress,
  isSmartAccountDeployedOnChain,
  buildDeployOnlyUserOperation,
  aaNetworkFromCaip2,
} from '../services/aaService';

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────
function toChecksumAddress(addr: string): string {
  try {
    return getAddress(addr.trim());
  } catch {
    return addr.trim();
  }
}

function safeStringify(x: any): string {
  try {
    if (x == null) return '';
    return typeof x === 'string' ? x : JSON.stringify(x);
  } catch {
    return String(x);
  }
}

// ── Dinari SDK Client ─────────────────────────────────────────────────────────
const getDinariClient = () =>
  new Dinari({
    apiKeyID: process.env['DINARI_API_ID'] || '',
    apiSecretKey: process.env['DINARI_API_SECRET'] || '',
    environment: (process.env['DINARI_ENVIRONMENT'] as 'sandbox' | 'production') || 'sandbox',
  });

/** Matches @dinari/api-sdk client base URLs. */
function getDinariEnterpriseBaseUrl(): string {
  const override = process.env['DINARI_BASE_URL']?.trim();
  if (override) return override.replace(/\/$/, '');
  return (process.env['DINARI_ENVIRONMENT'] || 'sandbox') === 'production'
    ? 'https://api-enterprise.sbt.dinari.com'
    : 'https://api-enterprise.sandbox.dinari.com';
}

/**
 * POST /api/v2/accounts/{account_id}/faucet — mints 1,000 mockUSD to the wallet linked to the account.
 * https://api-enterprise.sandbox.dinari.com/api/v2/docs#post-/api/v2/accounts/-account_id-/faucet
 */
const SANDBOX_FAUCET_CHAIN_IDS = new Set([
  'eip155:421614',
  'eip155:11155111',
  'eip155:84532',
  'eip155:168587773',
  'eip155:98867',
  'eip155:998',
]);

async function postAccountSandboxFaucet(accountId: string, chain_id: string): Promise<{ status: number; data: unknown }> {
  const base = getDinariEnterpriseBaseUrl();
  const apiKeyID = process.env['DINARI_API_ID'] || '';
  const apiSecretKey = process.env['DINARI_API_SECRET'] || '';
  const res = await axios.post(
    `${base}/api/v2/accounts/${accountId}/faucet`,
    { chain_id },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key-Id': apiKeyID,
        'X-API-Secret-Key': apiSecretKey,
      },
      timeout: 60000,
      validateStatus: (s) => s >= 200 && s < 300,
    },
  );
  return { status: res.status, data: res.data };
}

/** Ensures mockUSD on the order chain for the linked wallet (sandbox only). */
async function tapSandboxFaucetForOrderChain(
  client: Dinari,
  accountId: string,
  orderChainId: string,
  label: string,
): Promise<void> {
  if ((process.env['DINARI_ENVIRONMENT'] || 'sandbox') !== 'sandbox') return;
  if (!SANDBOX_FAUCET_CHAIN_IDS.has(orderChainId)) {
    console.log(`  Faucet v2 skipped (${label}): chain ${orderChainId} not in sandbox faucet list`);
    return;
  }
  try {
    const fr = await postAccountSandboxFaucet(accountId, orderChainId);
    const extra = fr.data != null && fr.data !== '' ? ` body=${safeStringify(fr.data)}` : '';
    console.log(
      `  Sandbox POST /faucet (${label}): HTTP ${fr.status} chain=${orderChainId} → linked wallet${extra}`,
    );
  } catch (e: any) {
    const detail = e.response?.data != null ? safeStringify(e.response.data) : e.message;
    console.warn(`  POST /faucet failed (${label}) ${orderChainId}: ${detail}; trying mintSandboxTokens`);
    try {
      await client.v2.accounts.mintSandboxTokens(accountId, { chain_id: orderChainId as any });
      console.log(`  mintSandboxTokens fallback (${label}): ${orderChainId}`);
    } catch (e2: any) {
      console.warn(`  mintSandboxTokens fallback failed: ${e2.message}`);
    }
  }
}

const DINARI_SANDBOX_DEFAULT_CAIP2 = 'eip155:11155111';
const ARB_SEPOLIA_CAIP2 = 'eip155:421614';

function dinariIsSandbox(): boolean {
  return (process.env['DINARI_ENVIRONMENT'] || 'sandbox') === 'sandbox';
}

/**
 * Sandbox Dinari wallet + dShares are on Ethereum Sepolia (`11155111`).
 * Older `.env` files often still set `421614` (Aave / AA); that breaks link vs order chain.
 * Opt back in with `DINARI_LEGACY_ARBITRUM_SEPOLIA=true`.
 */
function normalizeDinariEnvChain(raw: string | undefined, envKey: string): string {
  const v = raw?.trim();
  if (!v) {
    return dinariIsSandbox() ? DINARI_SANDBOX_DEFAULT_CAIP2 : ARB_SEPOLIA_CAIP2;
  }
  if (
    dinariIsSandbox() &&
    v === ARB_SEPOLIA_CAIP2 &&
    process.env['DINARI_LEGACY_ARBITRUM_SEPOLIA'] !== 'true'
  ) {
    console.warn(
      `[dinari] ${envKey}=${v} is ignored in sandbox: Dinari link/order use ${DINARI_SANDBOX_DEFAULT_CAIP2}. ` +
        `Update .env or set DINARI_LEGACY_ARBITRUM_SEPOLIA=true for the old single-chain setup.`,
    );
    return DINARI_SANDBOX_DEFAULT_CAIP2;
  }
  return v;
}

// Default Dinari order / dShare chain: Ethereum Sepolia in sandbox (matches Dinari sandbox catalog).
const ORDER_CHAIN_ID = normalizeDinariEnvChain(process.env['DINARI_ORDER_CHAIN_ID'], 'DINARI_ORDER_CHAIN_ID') as string;

/**
 * Dinari `connectInternal` chain — decoupled from Aave/AA on Arbitrum Sepolia.
 * Sandbox default: Ethereum Sepolia (`11155111`) where sandbox dShares are listed.
 */
function configuredWalletChainId(): string {
  return normalizeDinariEnvChain(process.env['DINARI_WALLET_CHAIN_ID'], 'DINARI_WALLET_CHAIN_ID');
}

const SMART_WALLET_CHAIN_ID = configuredWalletChainId() as string;

/** USD+ on Dinari-supported EVM chains (incl. testnets). Permit must use an API-supported token; see getCashBalances. */
const DEFAULT_PAYMENT_TOKEN = '0xC9E3df3D230980B45adC623C81C3DF4A73a5350f';

const erc20BalanceAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function rpcUrlForOrderChain(orderChainId: string): string | undefined {
  if (orderChainId === 'eip155:421614') {
    return (
      process.env['ARB_SEPOLIA_RPC_URL']?.trim() ||
      process.env['ALCHEMY_RPC_URL']?.trim()
    );
  }
  if (orderChainId === 'eip155:11155111') {
    return (
      process.env['SEPOLIA_RPC_URL']?.trim() ||
      process.env['ETH_SEPOLIA_RPC_URL']?.trim() ||
      'https://ethereum-sepolia.publicnode.com'
    );
  }
  return undefined;
}

async function readErc20Balance(
  orderChainId: string,
  token: `0x${string}`,
  holder: `0x${string}`,
): Promise<{ raw: bigint; decimals: number } | null> {
  const url = rpcUrlForOrderChain(orderChainId);
  if (!url) {
    console.warn(`  readErc20Balance: no RPC configured for ${orderChainId}`);
    return null;
  }
  const chain = orderChainId === 'eip155:11155111' ? sepolia : arbitrumSepolia;
  try {
    const client = createPublicClient({
      chain,
      transport: http(url),
    });
    const raw = await client.readContract({
      address: token,
      abi: erc20BalanceAbi,
      functionName: 'balanceOf',
      args: [holder],
    });
    let decimals = 6;
    try {
      decimals = await client.readContract({
        address: token,
        abi: erc20BalanceAbi,
        functionName: 'decimals',
      });
    } catch {
      /* assume 6 for USD+ */
    }
    return { raw, decimals };
  } catch (e: any) {
    console.warn(`  readErc20Balance failed (${orderChainId}): ${e.message}`);
    return null;
  }
}

/** Use Dinari cash balances for the token address the API accepts on this chain (avoids "payment token is not supported"). */
async function resolvePaymentTokenForPermit(
  client: Dinari,
  accountId: string,
  orderChainId: string,
): Promise<string> {
  const override = process.env['DINARI_PAYMENT_TOKEN']?.trim();
  if (override) return toChecksumAddress(override);
  try {
    const cash = await client.v2.accounts.getCashBalances(accountId);
    const row = cash.find((c) => c.chain_id === orderChainId);
    if (row?.token_address) {
      return toChecksumAddress(row.token_address);
    }
  } catch (e: any) {
    console.warn('  getCashBalances:', e.message);
  }
  return toChecksumAddress(DEFAULT_PAYMENT_TOKEN);
}

function resolvePaymentTokenFallback(orderChainId: string): string {
  const override = process.env['DINARI_PAYMENT_TOKEN']?.trim();
  if (override) return toChecksumAddress(override);
  return toChecksumAddress(DEFAULT_PAYMENT_TOKEN);
}

/**
 * Sandbox: HTTP 2xx from /faucet does not guarantee mint delivery — verify ERC-20 balance on the order chain.
 */
async function tapFaucetAndConfirmOnChain(
  client: Dinari,
  accountId: string,
  orderChainId: string,
  linkedWallet: `0x${string}`,
  paymentAmount: number,
  labelPrefix: string,
): Promise<string> {
  const sandbox = (process.env['DINARI_ENVIRONMENT'] || 'sandbox') === 'sandbox';
  let paymentToken = await resolvePaymentTokenForPermit(client, accountId, orderChainId);
  const minReadable = Number(paymentAmount);
  if (!sandbox || !SANDBOX_FAUCET_CHAIN_IDS.has(orderChainId)) {
    return paymentToken;
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    await tapSandboxFaucetForOrderChain(
      client,
      accountId,
      orderChainId,
      attempt === 0 ? `${labelPrefix} (initial)` : `${labelPrefix} (retry ${attempt})`,
    );
    await sleep(attempt === 0 ? 1500 : 2500);
    paymentToken = await resolvePaymentTokenForPermit(client, accountId, orderChainId);

    const snap = await readErc20Balance(
      orderChainId,
      paymentToken as `0x${string}`,
      linkedWallet,
    );

    if (!snap) {
      console.warn(
        `  On-chain read failed (attempt ${attempt + 1}/4) token=${paymentToken} — check RPC for ${orderChainId}`,
      );
      if (attempt === 3) {
        throw new Error(
          `Cannot verify sandbox funding: no ERC-20 balance read on ${orderChainId}. Set SEPOLIA_RPC_URL (Sepolia) and/or ARB_SEPOLIA_RPC_URL in .env.`,
        );
      }
      continue;
    }

    let required: bigint;
    try {
      required = parseUnits(String(paymentAmount), snap.decimals);
    } catch {
      required = 0n;
    }

    const human = formatUnits(snap.raw, snap.decimals);
    console.log(
      `  On-chain check: wallet=${linkedWallet} token=${paymentToken} chain=${orderChainId} balance=${human} (need ≥${minReadable})`,
    );
    if (snap.raw >= required) return paymentToken;

    if (attempt === 3) {
      throw new Error(
        `Sandbox faucet did not credit spendable balance on ${orderChainId}: linked wallet ${linkedWallet} has ${human} of ${paymentToken} but need at least ${minReadable}. ` +
          `If your Dinari wallet is linked on ${SMART_WALLET_CHAIN_ID} but this order used ${orderChainId}, the faucet often mints only on the linked chain — use a dShare token on ${SMART_WALLET_CHAIN_ID} or link the wallet on the order chain.`,
      );
    }
  }
  return paymentToken;
}

// Sandbox faucet: https://docs.dinari.com/docs/funding-accounts-through-wallets
// Mint on each distinct chain so USD+ exists where the linked wallet trades and where it lives on-chain.
const FAUCET_CHAIN_IDS: string[] = (() => {
  const raw = process.env['DINARI_FAUCET_CHAIN_IDS'];
  if (raw?.trim()) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const single = process.env['DINARI_FAUCET_CHAIN_ID']?.trim();
  const set = new Set<string>();
  if (single) set.add(single);
  set.add(ORDER_CHAIN_ID);
  set.add(configuredWalletChainId());
  // Sandbox dShares are often active on Sepolia per Dinari ordering docs; mint USD+ there too.
  if ((process.env['DINARI_ENVIRONMENT'] || 'sandbox') === 'sandbox') {
    set.add('eip155:11155111');
  }
  return [...set];
})();

// The organization entity ID created on partners.dinari.com.
const ORG_ENTITY_ID = process.env['DINARI_ENTITY_ID'] || '';

// Cache for stocks (refresh every 5 minutes, or when STOCKS_CACHE_VERSION changes)
const STOCKS_CACHE_VERSION = 'v4-dinari-ethereum-sepolia-default';
let cachedStocks: any[] = [];
let lastStockFetch = 0;
let stocksCacheVersionApplied = '';

// ── Yahoo Finance → Dinari ticker mapping ─────────────────────────────────────
const TICKER_ALIASES: Record<string, string[]> = {
  'GOOGL': ['GOOG', 'GOOGL'],
  'GOOG':  ['GOOG', 'GOOGL'],
  'BRK-B': ['BRKB', 'BRK.B', 'BRK-B'],
  'BRK.B': ['BRKB', 'BRK.B', 'BRK-B'],
  'META':  ['META', 'FB'],
  'FB':    ['META', 'FB'],
};

function normalizeTicker(yahooTicker: string): string[] {
  const upper = yahooTicker.toUpperCase().trim();
  const candidates = new Set<string>([upper]);
  if (TICKER_ALIASES[upper]) {
    for (const alias of TICKER_ALIASES[upper]) candidates.add(alias);
  }
  const stripped = upper.replace(/[-\.]/g, '');
  if (stripped !== upper) candidates.add(stripped);
  return [...candidates];
}

// ── Helper: Ensure stocks cache is warm ───────────────────────────────────────
async function ensureStocksCache(client: Dinari): Promise<void> {
  const now = Date.now();
  if (
    cachedStocks.length > 0 &&
    now - lastStockFetch < 5 * 60 * 1000 &&
    stocksCacheVersionApplied === STOCKS_CACHE_VERSION
  ) {
    return;
  }

  const stocks = await client.v2.marketData.stocks.list();
  const sandbox = (process.env['DINARI_ENVIRONMENT'] || 'sandbox') === 'sandbox';
  const walletChain = configuredWalletChainId();
  cachedStocks = stocks.map((s: any) => {
    let tokenAddress = '';
    let tokenChain = '';
    let token_pairs: { chain: string; addr: string }[] = [];
    if (Array.isArray(s.tokens)) {
      const pairs: { chain: string; addr: string }[] = [];
      for (const caip10 of s.tokens) {
        const parts = String(caip10).split(':');
        if (parts.length >= 3) {
          pairs.push({
            chain: `${parts[0]}:${parts[1]}`,
            addr: parts.slice(2).join(':'),
          });
        }
      }
      // Sandbox: prefer the chain where `connectInternal` linked the wallet (usually Arbitrum Sepolia).
      // Faucet + EIP-155 permits use that link; funding Sepolia while the wallet is only linked on 421614
      // returns HTTP 200 but mints nothing on-chain (single Wallet per Account in Dinari v2).
      // Production: prefer ORDER_CHAIN_ID then wallet chain.
      const preferredChains = sandbox
        ? [walletChain, 'eip155:11155111', ORDER_CHAIN_ID]
        : [ORDER_CHAIN_ID, walletChain];
      let hit: { chain: string; addr: string } | undefined;
      for (const pref of preferredChains) {
        hit = pairs.find((p) => p.chain === pref);
        if (hit) break;
      }
      if (hit) {
        tokenAddress = hit.addr;
        tokenChain = hit.chain;
      } else if (pairs[0]) {
        tokenAddress = pairs[0].addr;
        tokenChain = pairs[0].chain;
      }
      token_pairs = pairs;
    }
    return {
      id: s.id,
      ticker: (s.symbol || s.stock_ticker || s.ticker || '').toUpperCase(),
      name: s.name || s.display_name || '',
      is_active: s.is_tradable !== false && s.is_active !== false,
      token_address: tokenAddress,
      token_chain: tokenChain,
      token_pairs,
    };
  });
  lastStockFetch = now;
  stocksCacheVersionApplied = STOCKS_CACHE_VERSION;
  console.log(`Dinari stock cache: ${cachedStocks.length} stocks. ${cachedStocks.map(s => s.ticker).join(', ')}`);
}

// ── Helper: Resolve stock ticker to UUID ──────────────────────────────────────
async function resolveStockId(client: Dinari, tickerOrId: string): Promise<string> {
  await ensureStocksCache(client);
  if (tickerOrId.includes('-') && tickerOrId.length > 20) return tickerOrId;

  const candidates = normalizeTicker(tickerOrId);
  for (const c of candidates) {
    const s = cachedStocks.find(x => x.ticker === c);
    if (s) return s.id;
  }
  for (const c of candidates) {
    const s = cachedStocks.find(x => x.ticker.startsWith(c) || c.startsWith(x.ticker));
    if (s) return s.id;
  }
  throw new Error(`Stock "${tickerOrId}" not found. Tried: ${candidates.join(', ')}. Available: ${cachedStocks.map(s => s.ticker).join(', ')}`);
}

/**
 * CAIP-2 chain for this stock's dShare (must match createPermit `chain_id`).
 * When `linkedWalletChainId` matches a chain in Dinari's token list, use it so faucet + wallet link align.
 */
function getOrderChainIdForStock(stockUuid: string, linkedWalletChainId?: string): string {
  const row = cachedStocks.find((s) => s.id === stockUuid);
  const fallback = row?.token_chain?.trim() || ORDER_CHAIN_ID;
  const pairs = (row as any)?.token_pairs as { chain: string; addr: string }[] | undefined;
  if (!pairs?.length) return fallback;
  if (linkedWalletChainId) {
    const hit = pairs.find((p) => p.chain === linkedWalletChainId);
    if (hit) return linkedWalletChainId;
  }
  return fallback;
}

function tokenMetaForChain(stockUuid: string, chainId: string): { tokenAddress: string; tokenChain: string } {
  const row = cachedStocks.find((s) => s.id === stockUuid);
  const pairs = (row as any)?.token_pairs as { chain: string; addr: string }[] | undefined;
  const hit = pairs?.find((p) => p.chain === chainId);
  if (hit) return { tokenAddress: hit.addr, tokenChain: hit.chain };
  if (row?.token_chain === chainId && row.token_address) {
    return { tokenAddress: row.token_address, tokenChain: row.token_chain };
  }
  return { tokenAddress: row?.token_address || '', tokenChain: chainId };
}

// ── Helper: Derive smart wallet address from EOA ──────────────────────────────
async function deriveSmartWallet(eoaAddress: string): Promise<string> {
  return getSmartAccountAddress(eoaAddress as `0x${string}`);
}

function jsonNeedsDeployment(
  accountId: string,
  entityId: string,
  smartWalletAddress: string,
  alreadySetup: boolean,
) {
  return {
    accountId,
    entityId,
    smartWalletAddress,
    walletChainId: SMART_WALLET_CHAIN_ID,
    /** Pass to deploy-userop, execute-userop, and receipt when sponsoring on Ethereum Sepolia. */
    executeUserOpChainId: SMART_WALLET_CHAIN_ID,
    walletConnected: false,
    needsSmartWalletDeployment: true,
    alreadySetup,
  };
}

/** Dinari returns this when the SCW has no contract on the requested chain yet. */
function dinariSaysWalletNotOnChain(err: any): boolean {
  const blob = [
    err?.message,
    err?.error?.message,
    typeof err?.body === 'string' ? err.body : safeStringify(err?.body),
    typeof err?.response?.data === 'string' ? err.response.data : safeStringify(err?.response?.data),
  ]
    .filter(Boolean)
    .join(' ');
  return (
    /smart contract wallet exists on this chain/i.test(blob) ||
    /use chain id:\s*['"]eip155:0['"]/i.test(blob)
  );
}

async function mintSandboxFaucet(client: Dinari, accountId: string, context: string): Promise<void> {
  const sandbox = (process.env['DINARI_ENVIRONMENT'] || 'sandbox') === 'sandbox';
  for (const chain_id of FAUCET_CHAIN_IDS) {
    try {
      if (sandbox && SANDBOX_FAUCET_CHAIN_IDS.has(chain_id)) {
        await postAccountSandboxFaucet(accountId, chain_id);
        console.log(
          `  Sandbox POST /faucet (${context}): ${chain_id} (1,000 mockUSD to wallet on account)`,
        );
      } else {
        await client.v2.accounts.mintSandboxTokens(accountId, { chain_id: chain_id as any });
        console.log(`  mintSandboxTokens (${context}): ${chain_id}`);
      }
    } catch (e: any) {
      const detail = e.response?.data != null ? safeStringify(e.response.data) : e.message;
      console.warn(`  Primary faucet failed (${context}) ${chain_id}: ${detail}`);
      try {
        await client.v2.accounts.mintSandboxTokens(accountId, { chain_id: chain_id as any });
        console.log(`  mintSandboxTokens fallback (${context}): ${chain_id}`);
      } catch (e2: any) {
        console.warn(`  mintSandboxTokens fallback (${context}) ${chain_id}: ${e2.message}`);
      }
    }
  }
}

// ── Helper: Verify wallet is linked on the account ────────────────────────────
async function verifyWalletConnected(client: Dinari, accountId: string): Promise<{ connected: boolean; wallet?: any }> {
  try {
    const wallet = await client.v2.accounts.wallet.get(accountId);
    if (wallet?.address) {
      return { connected: true, wallet };
    }
    return { connected: false };
  } catch (e: any) {
    console.warn('  verifyWalletConnected failed:', e.message);
    return { connected: false };
  }
}

/**
 * Partner / org accounts: link a wallet as internal (no nonce or end-user signature).
 * See https://docs.dinari.com/reference/createaccountwalletinternalconnection
 */
async function linkInternalSmartWallet(
  client: Dinari,
  accountId: string,
  walletAddress: string,
  chainId: string = SMART_WALLET_CHAIN_ID,
): Promise<any> {
  const params: {
    wallet_address: string;
    chain_id: any;
    is_shared?: boolean;
  } = {
    wallet_address: toChecksumAddress(walletAddress),
    chain_id: chainId as any,
  };
  const sharedRaw = process.env['DINARI_WALLET_IS_SHARED'];
  if (sharedRaw === 'true') params.is_shared = true;
  if (sharedRaw === 'false') params.is_shared = false;
  return client.v2.accounts.wallet.connectInternal(accountId, params);
}

/** Calls connectInternal; if the smart wallet is already linked, returns the existing wallet. */
async function ensureInternalSmartWalletLinked(
  client: Dinari,
  accountId: string,
  smartWalletAddress: string,
  chainId: string = SMART_WALLET_CHAIN_ID,
): Promise<any> {
  const smart = toChecksumAddress(smartWalletAddress);
  try {
    return await linkInternalSmartWallet(client, accountId, smart, chainId);
  } catch (err: any) {
    const verification = await verifyWalletConnected(client, accountId);
    const linkedAddr = verification.wallet?.address
      ? toChecksumAddress(String(verification.wallet.address))
      : '';
    if (verification.connected && linkedAddr.toLowerCase() === smart.toLowerCase()) {
      console.log(`  Internal link skipped (already linked): ${linkedAddr}`);
      return verification.wallet;
    }
    throw err;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ── SETUP: Account under org entity + internal wallet link (smart wallet) ─────
// Internal connect: https://docs.dinari.com/reference/createaccountwalletinternalconnection
router.post('/setup', async (req, res) => {
  try {
    const { walletAddress } = req.body;
    if (!walletAddress) return res.status(400).json({ error: 'walletAddress is required' });

    if (!ORG_ENTITY_ID) {
      return res.status(500).json({ error: 'DINARI_ENTITY_ID not set in .env' });
    }

    const eoaAddress = toChecksumAddress(walletAddress);
    const eoaKey = walletAddress.toLowerCase();
    const client = getDinariClient();

    let smartWalletAddress: string;
    try {
      const sw = await deriveSmartWallet(eoaAddress);
      smartWalletAddress = toChecksumAddress(sw);
    } catch (e: any) {
      console.error('  deriveSmartWallet failed:', e.message || e);
      return res.status(500).json({
        error: 'Could not derive smart wallet address for this signer',
        details: e.message,
      });
    }
    console.log(`\n=== SETUP ===`);
    console.log(`  EOA (Privy owner): ${eoaAddress}`);
    console.log(`  Smart wallet:      ${smartWalletAddress}`);
    console.log(`  Org entity:        ${ORG_ENTITY_ID}`);

    // ── Check if user already set up ──
    const existing = getUserByWallet(eoaKey);
    if (existing) {
      console.log(`  Found existing mapping: entity=${existing.entity_id} account=${existing.account_id}`);
      try {
        await client.v2.accounts.retrieve(existing.account_id);

        const verification = await verifyWalletConnected(client, existing.account_id);
        const linkedAddr = verification.wallet?.address
          ? toChecksumAddress(String(verification.wallet.address))
          : '';
        const smartWalletLinked =
          verification.connected &&
          linkedAddr.toLowerCase() === smartWalletAddress.toLowerCase();
        if (smartWalletLinked) {
          console.log(`  Smart wallet already connected: ${linkedAddr} chain=${verification.wallet?.chain_id}`);
          return res.json({
            accountId: existing.account_id,
            entityId: existing.entity_id,
            smartWalletAddress,
            walletConnected: true,
            alreadySetup: true,
          });
        }
        if (verification.connected && linkedAddr) {
          console.log(
            `  Existing link ${linkedAddr} is not the derived smart wallet – replacing via internal connect`,
          );
        }

        const onChain = await isSmartAccountDeployedOnChain(
          smartWalletAddress as `0x${string}`,
          SMART_WALLET_CHAIN_ID,
        );
        if (!onChain) {
          console.log(
            `  Smart wallet not deployed on ${SMART_WALLET_CHAIN_ID} yet; Dinari requires bytecode on the linked chain.`,
          );
          return res.json(
            jsonNeedsDeployment(existing.account_id, existing.entity_id, smartWalletAddress, true),
          );
        }

        console.log(`  Linking smart wallet (internal) on ${SMART_WALLET_CHAIN_ID}...`);
        let linkedWallet: any;
        try {
          linkedWallet = await ensureInternalSmartWalletLinked(
            client,
            existing.account_id,
            smartWalletAddress,
          );
        } catch (linkErr: any) {
          if (dinariSaysWalletNotOnChain(linkErr)) {
            console.warn(
              '  Dinari: wallet not on-chain; client should run deploy-userop then retry setup.',
            );
            return res.json(
              jsonNeedsDeployment(existing.account_id, existing.entity_id, smartWalletAddress, true),
            );
          }
          throw linkErr;
        }
        console.log(
          `  Internal link returned: address=${linkedWallet.address} chain=${linkedWallet.chain_id} managed=${linkedWallet.is_managed_wallet}`,
        );
        await mintSandboxFaucet(client, existing.account_id, 'after internal link');

        return res.json({
          accountId: existing.account_id,
          entityId: existing.entity_id,
          smartWalletAddress,
          walletChainId: SMART_WALLET_CHAIN_ID,
          wallet: linkedWallet,
          walletConnected: true,
          alreadySetup: true,
        });
      } catch (e: any) {
        console.log(`  Stale mapping for ${eoaKey}: ${e.message}. Cleaning up.`);
        deleteUser(eoaKey);
      }
    }

    // ── Fresh setup: create account under the ORG entity ──
    // The org entity already has KYB approved on partners.dinari.com,
    // so we skip entity creation and KYC – just create an account directly.
    console.log(`  Creating new account under org entity ${ORG_ENTITY_ID}...`);

    const account = await client.v2.entities.accounts.create(ORG_ENTITY_ID);
    console.log(`  Created account: ${account.id} (under org entity)`);

    saveUser(eoaKey, ORG_ENTITY_ID, account.id);

    const onChain = await isSmartAccountDeployedOnChain(
      smartWalletAddress as `0x${string}`,
      SMART_WALLET_CHAIN_ID,
    );
    if (!onChain) {
      console.log(`  Smart wallet not deployed on ${SMART_WALLET_CHAIN_ID} yet; return deploy step before internal link.`);
      return res.json(jsonNeedsDeployment(account.id, ORG_ENTITY_ID, smartWalletAddress, false));
    }

    console.log(`  Linking smart wallet (internal) on ${SMART_WALLET_CHAIN_ID}...`);
    let linkedWallet: any;
    try {
      linkedWallet = await ensureInternalSmartWalletLinked(client, account.id, smartWalletAddress);
    } catch (linkErr: any) {
      if (dinariSaysWalletNotOnChain(linkErr)) {
        console.warn(
          '  Dinari: wallet not on-chain; client should run deploy-userop then retry setup.',
        );
        return res.json(jsonNeedsDeployment(account.id, ORG_ENTITY_ID, smartWalletAddress, false));
      }
      throw linkErr;
    }
    console.log(
      `  Internal link returned: address=${linkedWallet.address} chain=${linkedWallet.chain_id} managed=${linkedWallet.is_managed_wallet}`,
    );
    await mintSandboxFaucet(client, account.id, 'after internal link');

    res.json({
      accountId: account.id,
      entityId: ORG_ENTITY_ID,
      smartWalletAddress,
      walletChainId: SMART_WALLET_CHAIN_ID,
      wallet: linkedWallet,
      walletConnected: true,
      alreadySetup: false,
    });
  } catch (error: any) {
    console.error('Setup Error:', error.message || error);
    res.status(500).json({ error: 'Failed to setup Dinari account', details: error.message });
  }
});

/**
 * Gasless deploy UserOp for the smart account on the Dinari link chain (sandbox: Ethereum Sepolia)
 * or Arbitrum Sepolia when `chainId` is `eip155:421614`.
 * Query: `chainId` (optional) defaults to `SMART_WALLET_CHAIN_ID` / `DINARI_WALLET_CHAIN_ID`.
 */
router.get('/deploy-userop', async (req, res) => {
  try {
    const walletAddress = req.query.walletAddress as string | undefined;
    if (!walletAddress?.trim()) {
      return res.status(400).json({ error: 'walletAddress query parameter required' });
    }
    const chainId = (req.query.chainId as string | undefined)?.trim() || SMART_WALLET_CHAIN_ID;
    const owner = toChecksumAddress(walletAddress) as `0x${string}`;
    const network = aaNetworkFromCaip2(chainId);
    const { userOp, userOpHash, smartAccountAddress } = await buildDeployOnlyUserOperation(
      owner,
      network,
    );
    const bigIntReplacer = (_k: any, value: any) =>
      typeof value === 'bigint' ? value.toString() : value;
    res.json(
      JSON.parse(
        JSON.stringify(
          { userOp, userOpHash, smartAccountAddress, chainId, executeUserOpChainId: chainId },
          bigIntReplacer,
        ),
      ),
    );
  } catch (error: any) {
    console.error('deploy-userop Error:', error);
    res.status(500).json({ error: 'Failed to build deploy user operation', details: error.message });
  }
});

// ── CONNECT WALLET: Internal link (server-side, partner API key) ─────────────
router.post('/connect-wallet', async (req, res) => {
  try {
    const { accountId, walletAddress, walletChainId } = req.body;
    if (!accountId || !walletAddress) {
      return res.status(400).json({ error: 'accountId, walletAddress required' });
    }

    const checksumAddr = toChecksumAddress(walletAddress);
    const chainId = (walletChainId || SMART_WALLET_CHAIN_ID) as any;

    console.log(`\n=== CONNECT WALLET (internal) ===`);
    console.log(`  accountId: ${accountId}`);
    console.log(`  address:   ${checksumAddr}`);
    console.log(`  chainId:   ${chainId}`);

    const client = getDinariClient();

    const linkedWallet = await ensureInternalSmartWalletLinked(client, accountId, checksumAddr, chainId);
    console.log(
      `  Internal connect returned: address=${linkedWallet.address} chain=${linkedWallet.chain_id} managed=${linkedWallet.is_managed_wallet} aml=${linkedWallet.is_aml_flagged}`,
    );

    const verification = await verifyWalletConnected(client, accountId);
    console.log(`  Post-connect verification: connected=${verification.connected} wallet=${verification.wallet?.address ?? 'none'}`);

    await mintSandboxFaucet(client, accountId, 'after internal connect');

    res.json({ success: true, wallet: linkedWallet, verified: verification.connected });
  } catch (error: any) {
    console.error('Connect Wallet Error:', error.message || error);
    res.status(500).json({ error: 'Failed to connect wallet', details: error.message });
  }
});

// ── STOCKS: List tradeable dShare stocks ──────────────────────────────────────
router.get('/stocks', async (_req, res) => {
  try {
    const client = getDinariClient();
    await ensureStocksCache(client);
    res.json({ stocks: cachedStocks });
  } catch (error: any) {
    console.error('Stocks Error:', error.message || error);
    res.status(500).json({ error: 'Failed to fetch stocks', details: error.message });
  }
});

// ── CHECK TRADEABILITY ────────────────────────────────────────────────────────
router.get('/stocks/check/:ticker', async (req, res) => {
  try {
    const { ticker } = req.params;
    const client = getDinariClient();
    await ensureStocksCache(client);

    const candidates = normalizeTicker(ticker);
    let match = cachedStocks.find(s => candidates.includes(s.ticker) && s.is_active);
    if (!match) {
      const upper = ticker.toUpperCase().trim();
      match = cachedStocks.find(s => s.is_active && (s.ticker.startsWith(upper) || upper.startsWith(s.ticker)));
    }
    if (!match) return res.json({ tradeable: false, ticker, dinariTicker: null });

    let linkedChainId: string | undefined;
    const wa = typeof req.query.walletAddress === 'string' ? req.query.walletAddress.trim() : '';
    if (wa) {
      const u = getUserByWallet(wa.toLowerCase());
      if (u) {
        const ws = await verifyWalletConnected(client, u.account_id);
        linkedChainId = ws.wallet?.chain_id ? String(ws.wallet.chain_id) : undefined;
      }
    }
    const orderChain = getOrderChainIdForStock(match.id, linkedChainId);
    const meta = tokenMetaForChain(match.id, orderChain);

    let quote: any = null;
    try { quote = await client.v2.marketData.stocks.retrieveCurrentQuote(match.id); } catch (_) {}

    res.json({
      tradeable: true,
      ticker,
      dinariTicker: match.ticker,
      stockId: match.id,
      name: match.name,
      tokenAddress: meta.tokenAddress || match.token_address,
      tokenChain: meta.tokenChain || match.token_chain,
      quote,
    });
  } catch (error: any) {
    console.error('Check Tradeable Error:', error.message || error);
    res.status(500).json({ error: 'Failed to check tradeability', details: error.message });
  }
});

// ── STOCK QUOTE ───────────────────────────────────────────────────────────────
router.get('/stocks/:id/quote', async (req, res) => {
  try {
    const client = getDinariClient();
    const actualId = await resolveStockId(client, req.params.id);
    const quote = await client.v2.marketData.stocks.retrieveCurrentQuote(actualId);
    res.json(quote);
  } catch (error: any) {
    console.error('Quote Error:', error.message || error);
    res.status(500).json({ error: 'Failed to get quote', details: error.message });
  }
});

// ── PREPARE BUY ORDER (Dinari-sponsored EIP-712 permit) ───────────────────────
router.post('/order/prepare-buy', async (req, res) => {
  try {
    const { walletAddress, stockId, paymentAmount } = req.body;
    if (!walletAddress || !stockId || !paymentAmount)
      return res.status(400).json({ error: 'walletAddress, stockId, paymentAmount required' });

    const user = getUserByWallet(walletAddress.toLowerCase());
    if (!user) return res.status(404).json({ error: 'User not set up. Call /setup first.' });

    const client = getDinariClient();
    const actualStockId = await resolveStockId(client, stockId);
    const walletState = await verifyWalletConnected(client, user.account_id);
    const linkedChainId = walletState.wallet?.chain_id
      ? String(walletState.wallet.chain_id)
      : SMART_WALLET_CHAIN_ID;
    let orderChainId = getOrderChainIdForStock(actualStockId, linkedChainId);
    const eoaChecksum = toChecksumAddress(walletAddress);
    const linkedWallet = (await deriveSmartWallet(eoaChecksum)) as `0x${string}`;

    // Dinari v2: one wallet per account; you cannot call connectInternal again on another chain.
    // Sepolia-only dShares + wallet linked on Arbitrum Sepolia => faucet/permit cannot align.
    if (orderChainId !== linkedChainId) {
      return res.status(400).json({
        error: 'Wallet chain does not match this stock’s dShare chain',
        details: `This order must use ${orderChainId} (dShare / permit), but the Dinari wallet for this account is linked on ${linkedChainId}. Dinari does not allow re-linking the same account to a different chain. Use a stock that trades on ${linkedChainId}, or create a new Dinari account with the wallet linked on ${orderChainId} (set DINARI_WALLET_CHAIN_ID in .env before first setup).`,
        orderChainId,
        linkedChainId,
      });
    }

    let paymentToken = await tapFaucetAndConfirmOnChain(
      client,
      user.account_id,
      orderChainId,
      linkedWallet,
      parseFloat(paymentAmount),
      'prepare buy',
    );

    // chain_id must be the chain where Dinari has an active dShare for this asset (see market `token_chain`).
    let permitResponse;
    try {
      permitResponse = await client.v2.accounts.orderRequests.eip155.createPermit(user.account_id, {
      chain_id: orderChainId as any,
      order_side: 'BUY',
      order_tif: 'DAY',
      order_type: 'MARKET',
      stock_id: actualStockId,
      payment_token: paymentToken,
      payment_token_quantity: parseFloat(paymentAmount),
    });
    } catch (first: any) {
      const msg = String(first?.message ?? first);
      if (
        /insufficient payment token balance/i.test(msg) &&
        (process.env['DINARI_ENVIRONMENT'] || 'sandbox') === 'sandbox'
      ) {
        console.warn('  Buy permit: insufficient balance — retrying funding + permit');
        paymentToken = await tapFaucetAndConfirmOnChain(
          client,
          user.account_id,
          orderChainId,
          linkedWallet,
          parseFloat(paymentAmount),
          'prepare buy (after insufficient balance)',
        );
        permitResponse = await client.v2.accounts.orderRequests.eip155.createPermit(user.account_id, {
          chain_id: orderChainId as any,
          order_side: 'BUY',
          order_tif: 'DAY',
          order_type: 'MARKET',
          stock_id: actualStockId,
          payment_token: paymentToken,
          payment_token_quantity: parseFloat(paymentAmount),
        });
      } else {
        throw first;
      }
    }

    res.json({
      permit: permitResponse.permit,
      orderRequestId: permitResponse.order_request_id,
      accountId: user.account_id,
      orderChainId,
    });
  } catch (error: any) {
    console.error('Prepare Buy Error:', error.message || error);
    res.status(500).json({ error: 'Failed to prepare buy order', details: error.message });
  }
});

// ── PREPARE SELL ORDER (Dinari-sponsored EIP-712 permit) ──────────────────────
router.post('/order/prepare-sell', async (req, res) => {
  try {
    const { walletAddress, stockId, assetQuantity } = req.body;
    if (!walletAddress || !stockId || !assetQuantity)
      return res.status(400).json({ error: 'walletAddress, stockId, assetQuantity required' });

    const user = getUserByWallet(walletAddress.toLowerCase());
    if (!user) return res.status(404).json({ error: 'User not set up. Call /setup first.' });

    const client = getDinariClient();
    const actualStockId = await resolveStockId(client, stockId);
    const walletState = await verifyWalletConnected(client, user.account_id);
    const linkedChainId = walletState.wallet?.chain_id
      ? String(walletState.wallet.chain_id)
      : SMART_WALLET_CHAIN_ID;
    let orderChainId = getOrderChainIdForStock(actualStockId, linkedChainId);

    if (orderChainId !== linkedChainId) {
      return res.status(400).json({
        error: 'Wallet chain does not match this stock’s dShare chain',
        details: `This order must use ${orderChainId}, but the Dinari wallet is linked on ${linkedChainId}. Use a stock on ${linkedChainId} or an account linked on ${orderChainId}.`,
        orderChainId,
        linkedChainId,
      });
    }

    const paymentToken = await resolvePaymentTokenForPermit(client, user.account_id, orderChainId);

    const permitResponse = await client.v2.accounts.orderRequests.eip155.createPermit(user.account_id, {
      chain_id: orderChainId as any,
      order_side: 'SELL',
      order_tif: 'DAY',
      order_type: 'MARKET',
      stock_id: actualStockId,
      payment_token: paymentToken,
      asset_token_quantity: parseFloat(assetQuantity),
    });

    res.json({
      permit: permitResponse.permit,
      orderRequestId: permitResponse.order_request_id,
      accountId: user.account_id,
      orderChainId,
    });
  } catch (error: any) {
    console.error('Prepare Sell Error:', error.message || error);
    res.status(500).json({ error: 'Failed to prepare sell order', details: error.message });
  }
});

// ── SUBMIT ORDER (Dinari-sponsored: Dinari sends the on-chain tx) ─────────────
router.post('/order/submit', async (req, res) => {
  try {
    const { accountId, orderRequestId, permitSignature } = req.body;
    if (!accountId || !orderRequestId || !permitSignature)
      return res.status(400).json({ error: 'accountId, orderRequestId, permitSignature required' });

    const client = getDinariClient();
    const result = await client.v2.accounts.orderRequests.eip155.submit(accountId, {
      order_request_id: orderRequestId,
      permit_signature: permitSignature,
    });

    res.json({ success: true, order: result });
  } catch (error: any) {
    console.error('Submit Order Error:', error.message || error);
    res.status(500).json({ error: 'Failed to submit order', details: error.message });
  }
});

// ── PORTFOLIO: Read dShare balances via Alchemy ───────────────────────────────
router.get('/portfolio/:walletAddress', async (req, res) => {
  try {
    const eoaAddress = req.params.walletAddress;
    const eoaKey = eoaAddress.toLowerCase();
    const client = getDinariClient();
    await ensureStocksCache(client);

    const dShareTokens = cachedStocks
      .filter(s => s.token_address?.startsWith('0x'))
      .map(s => s.token_address);
    if (dShareTokens.length === 0)
      return res.json({ holdings: [], smartWalletAddress: null, totalValue: 0 });

    const alchemyRpc = process.env['ALCHEMY_RPC_URL'] || 'https://arb-sepolia.g.alchemy.com/v2/demo';

    async function fetchBalances(addr: string) {
      const resp = await axios.post(alchemyRpc, {
        jsonrpc: '2.0', id: 1,
        method: 'alchemy_getTokenBalances',
        params: [addr.toLowerCase(), dShareTokens],
      }, { timeout: 10000 });
      return resp.data?.result?.tokenBalances || [];
    }

    // Fetch for both EOA and smart wallet
    const eoaBalances = await fetchBalances(eoaKey);
    let smartWalletAddress: string | null = null;
    let swBalances: any[] = [];
    try {
      smartWalletAddress = await deriveSmartWallet(eoaAddress);
      swBalances = await fetchBalances(smartWalletAddress);
    } catch (_) {}

    const balanceMap: Record<string, bigint> = {};
    for (const tb of [...eoaBalances, ...swBalances]) {
      const addr = tb.contractAddress.toLowerCase();
      const raw = BigInt(tb.tokenBalance || '0');
      balanceMap[addr] = (balanceMap[addr] || 0n) + raw;
    }

    const holdings: any[] = [];
    let totalValue = 0;
    for (const [contractAddr, rawBal] of Object.entries(balanceMap)) {
      if (rawBal === 0n) continue;
      const stock = cachedStocks.find(s => s.token_address.toLowerCase() === contractAddr);
      if (!stock) continue;
      const balance = Number(rawBal) / 1e18;
      let price = 0;
      try {
        const q = await client.v2.marketData.stocks.retrieveCurrentQuote(stock.id);
        price = (q as any)?.price ?? 0;
      } catch (_) {}
      const value = balance * price;
      totalValue += value;
      holdings.push({ ticker: stock.ticker, name: stock.name, stockId: stock.id, tokenAddress: stock.token_address, balance, price, value });
    }
    res.json({ holdings, smartWalletAddress, totalValue });
  } catch (error: any) {
    console.error('Portfolio Error:', error.message || error);
    res.status(500).json({ error: 'Failed to fetch portfolio', details: error.message });
  }
});

// ── ORDERS: List order history ────────────────────────────────────────────────
router.get('/orders/:walletAddress', async (req, res) => {
  try {
    const user = getUserByWallet(req.params.walletAddress.toLowerCase());
    if (!user) return res.status(404).json({ error: 'User not found' });
    const client = getDinariClient();
    await ensureStocksCache(client);
    const orders = await client.v2.accounts.orderRequests.list(user.account_id);
    res.json({
      orders: (orders as any[]).map((o: any) => {
        const stock = cachedStocks.find(s => s.id === o.stock_id);
        return {
          id: o.id, stock_id: o.stock_id, ticker: stock?.ticker || '', stock_name: stock?.name || '',
          order_side: o.order_side, order_type: o.order_type, status: o.status,
          payment_amount: o.payment_amount, asset_quantity: o.asset_quantity, created_at: o.created_at,
        };
      }),
    });
  } catch (error: any) {
    console.error('Orders Error:', error.message || error);
    res.status(500).json({ error: 'Failed to fetch orders', details: error.message });
  }
});

// ── ORDER STATUS ──────────────────────────────────────────────────────────────
router.get('/order-status/:walletAddress/:orderId', async (req, res) => {
  try {
    const user = getUserByWallet(req.params.walletAddress.toLowerCase());
    if (!user) return res.status(404).json({ error: 'User not found' });
    const client = getDinariClient();
    await ensureStocksCache(client);
    const orders = await client.v2.accounts.orderRequests.list(user.account_id);
    const order = (orders as any[]).find((o: any) => o.id === req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const stock = cachedStocks.find(s => s.id === order.stock_id);
    res.json({
      id: order.id, stock_id: order.stock_id, ticker: stock?.ticker || '', stock_name: stock?.name || '',
      order_side: order.order_side, order_type: order.order_type, status: order.status,
      payment_amount: order.payment_amount, asset_quantity: order.asset_quantity, created_at: order.created_at,
    });
  } catch (error: any) {
    console.error('Order Status Error:', error.message || error);
    res.status(500).json({ error: 'Failed to get order status', details: error.message });
  }
});

// ── FAUCET: Mint sandbox tokens ───────────────────────────────────────────────
router.post('/faucet/:walletAddress', async (req, res) => {
  try {
    const user = getUserByWallet(req.params.walletAddress.toLowerCase());
    if (!user) return res.status(404).json({ error: 'User not found' });
    const client = getDinariClient();
    await mintSandboxFaucet(client, user.account_id, 'faucet route');
    res.json({ success: true, message: 'Sandbox faucet mint attempted for chains: ' + FAUCET_CHAIN_IDS.join(', ') });
  } catch (error: any) {
    console.error('Faucet Error:', error.message || error);
    res.status(500).json({ error: 'Failed to mint tokens', details: error.message });
  }
});

// ── USER INFO ─────────────────────────────────────────────────────────────────
router.get('/user/:walletAddress', async (req, res) => {
  try {
    const user = getUserByWallet(req.params.walletAddress.toLowerCase());
    if (!user) return res.json({ setup: false });
    res.json({ setup: true, accountId: user.account_id, entityId: user.entity_id });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// ── PAYMENT TOKEN INFO ────────────────────────────────────────────────────────
router.get('/payment-token', async (req, res) => {
  const chain =
    (typeof req.query.orderChainId === 'string' && req.query.orderChainId.trim()) || ORDER_CHAIN_ID;
  let address = resolvePaymentTokenFallback(chain);
  const w = typeof req.query.walletAddress === 'string' ? req.query.walletAddress.trim() : '';
  if (w) {
    const u = getUserByWallet(w.toLowerCase());
    if (u) {
      try {
        const cli = getDinariClient();
        address = await resolvePaymentTokenForPermit(cli, u.account_id, chain);
      } catch (_) {}
    }
  }
  res.json({
    address,
    orderChainId: chain,
    chain,
  });
});

// ── DEBUG: Check API key health & wallet status ──────────────────────────────
router.get('/debug/health', async (_req, res) => {
  const results: Record<string, any> = {
    apiKeyId: (process.env['DINARI_API_ID'] || '').slice(0, 12) + '...',
    environment: process.env['DINARI_ENVIRONMENT'] || 'sandbox',
    orderChainId: ORDER_CHAIN_ID,
    paymentTokenFallback: resolvePaymentTokenFallback(ORDER_CHAIN_ID),
    smartWalletChainId: SMART_WALLET_CHAIN_ID,
    faucetChainIds: FAUCET_CHAIN_IDS,
  };

  try {
    const client = getDinariClient();
    const stocks = await client.v2.marketData.stocks.list();
    results.apiKeyValid = true;
    results.stockCount = stocks.length;
    results.sampleStocks = stocks.slice(0, 3).map((s: any) => s.symbol || s.stock_ticker || s.name);
  } catch (e: any) {
    results.apiKeyValid = false;
    results.apiKeyError = e.message;
  }

  res.json(results);
});

router.get('/debug/account/:walletAddress', async (req, res) => {
  try {
    const eoaKey = req.params.walletAddress.toLowerCase();
    const user = getUserByWallet(eoaKey);
    if (!user) return res.json({ found: false });

    const client = getDinariClient();
    let accountOk = false;
    let walletInfo: any = null;

    try {
      await client.v2.accounts.retrieve(user.account_id);
      accountOk = true;
    } catch (e: any) {
      return res.json({ found: true, ...user, accountValid: false, error: e.message });
    }

    try {
      walletInfo = await client.v2.accounts.wallet.get(user.account_id);
    } catch (_) {}

    res.json({
      found: true,
      ...user,
      accountValid: accountOk,
      walletConnected: !!walletInfo?.address,
      walletInfo,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
