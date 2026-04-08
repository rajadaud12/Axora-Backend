import { Router } from 'express';
import Dinari from '@dinari/api-sdk';
import axios from 'axios';
import { getAddress } from 'viem';
import { getUserByWallet, saveUser, deleteUser } from '../db';
import { getSmartAccountAddress } from '../services/aaService';

const router = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────
function toChecksumAddress(addr: string): string {
  try {
    return getAddress(addr.trim());
  } catch {
    return addr.trim();
  }
}

function cleanSignature(sig: string): string {
  let s = sig.trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  try {
    const decoded = JSON.parse(s);
    if (typeof decoded === 'string') s = decoded.trim();
  } catch {}
  if (!s.startsWith('0x')) s = '0x' + s;
  return s;
}

// ── Dinari SDK Client ─────────────────────────────────────────────────────────
const getDinariClient = () =>
  new Dinari({
    apiKeyID: process.env['DINARI_API_ID'] || '',
    apiSecretKey: process.env['DINARI_API_SECRET'] || '',
    environment: (process.env['DINARI_ENVIRONMENT'] as 'sandbox' | 'production') || 'sandbox',
  });

// Chain where dShares and orders live.  For this sandbox API key the stock
// tokens are deployed on Sepolia (eip155:11155111).
const ORDER_CHAIN_ID = (process.env['DINARI_ORDER_CHAIN_ID'] || 'eip155:11155111') as string;

// USD+ payment token address — same on every testnet chain.
// Source: https://docs.dinari.com/docs/usdplus-evm
const PAYMENT_TOKEN = process.env['DINARI_PAYMENT_TOKEN'] || '0xC9E3df3D230980B45adC623C81C3DF4A73a5350f';

// The organization entity ID created on partners.dinari.com.
const ORG_ENTITY_ID = process.env['DINARI_ENTITY_ID'] || '';

// Cache for stocks (refresh every 5 minutes)
let cachedStocks: any[] = [];
let lastStockFetch = 0;

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
  if (cachedStocks.length > 0 && now - lastStockFetch < 5 * 60 * 1000) return;

  const stocks = await client.v2.marketData.stocks.list();
  cachedStocks = stocks.map((s: any) => {
    let tokenAddress = '';
    let tokenChain = '';
    if (Array.isArray(s.tokens)) {
      for (const caip10 of s.tokens) {
        const parts = String(caip10).split(':');
        if (parts.length >= 3) {
          const chain = `${parts[0]}:${parts[1]}`;
          const addr = parts.slice(2).join(':');
          if (chain === ORDER_CHAIN_ID) { tokenAddress = addr; tokenChain = chain; break; }
          if (!tokenAddress) { tokenAddress = addr; tokenChain = chain; }
        }
      }
    }
    return {
      id: s.id,
      ticker: (s.symbol || s.stock_ticker || s.ticker || '').toUpperCase(),
      name: s.name || s.display_name || '',
      is_active: s.is_tradable !== false && s.is_active !== false,
      token_address: tokenAddress,
      token_chain: tokenChain,
    };
  });
  lastStockFetch = now;
  console.log(`Dinari stock cache: ${cachedStocks.length} stocks. ${cachedStocks.map(s => s.ticker).join(', ')}`);
}

// ── Helper: Resolve stock ticker to UUID ──────────────────────────────────────
async function resolveStockId(client: Dinari, tickerOrId: string): Promise<string> {
  if (tickerOrId.includes('-') && tickerOrId.length > 20) return tickerOrId;
  await ensureStocksCache(client);

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

// ── Helper: Derive smart wallet address from EOA ──────────────────────────────
async function deriveSmartWallet(eoaAddress: string): Promise<string> {
  return getSmartAccountAddress(eoaAddress as `0x${string}`);
}

// Wallet chain for Dinari connection.  EOA wallets use eip155:0 (chain-agnostic).
// Smart contract wallets use the chain they're deployed on.
const WALLET_CHAIN_ID = 'eip155:0';
const SMART_WALLET_CHAIN_ID = (process.env['DINARI_WALLET_CHAIN_ID'] || 'eip155:421614') as string;

// ── Helper: Verify wallet is actually connected after connect call ────────────
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

async function getNonceForWallet(
  client: Dinari,
  accountId: string,
  eoaAddress: string,
  smartWalletAddress?: string | null,
): Promise<{ nonce: string; message: string; walletAddress: string; walletChainId: string }> {
  const checksumEoa = toChecksumAddress(eoaAddress);
  const checksumSmart = smartWalletAddress ? toChecksumAddress(smartWalletAddress) : null;

  const tryGet = async (walletAddress: string, chainId: string) => {
    console.log(`  getNonce: trying wallet=${walletAddress} chain=${chainId}`);
    const resp = await client.v2.accounts.wallet.external.getNonce(accountId, {
      chain_id: chainId as any,
      wallet_address: walletAddress,
    });
    console.log(`  getNonce: success – nonce=${resp.nonce}`);
    return { nonce: resp.nonce, message: resp.message, walletAddress, walletChainId: chainId };
  };

  // Strategy: try EOA (eip155:0) first, then smart wallet chain if needed
  const strategies: Array<[string, string]> = [
    [checksumEoa, WALLET_CHAIN_ID],
  ];
  if (checksumSmart) {
    strategies.push([checksumSmart, SMART_WALLET_CHAIN_ID]);
    strategies.push([checksumEoa, SMART_WALLET_CHAIN_ID]);
  } else {
    strategies.push([checksumEoa, SMART_WALLET_CHAIN_ID]);
  }

  let lastError: any = null;
  for (const [addr, chain] of strategies) {
    try {
      return await tryGet(addr, chain);
    } catch (err: any) {
      console.warn(`  getNonce failed for ${addr} on ${chain}: ${err.message}`);
      lastError = err;
      const msg = String(err?.message || '').toLowerCase();
      const isSmartHint = msg.includes('smart contract wallet') || msg.includes('specify the chain id');
      if (!isSmartHint && chain === WALLET_CHAIN_ID) {
        throw err;
      }
    }
  }
  throw lastError;
}

// ══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// ── SETUP: Account → Nonce (under the ORG entity from partners.dinari.com) ───
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

    let smartWalletAddress: string | null = null;
    try {
      smartWalletAddress = await deriveSmartWallet(eoaAddress);
      if (smartWalletAddress) smartWalletAddress = toChecksumAddress(smartWalletAddress);
    } catch (_) {}
    console.log(`\n=== SETUP ===`);
    console.log(`  EOA (checksum): ${eoaAddress}`);
    console.log(`  Smart wallet:   ${smartWalletAddress ?? 'none'}`);
    console.log(`  Org entity:     ${ORG_ENTITY_ID}`);

    // ── Check if user already set up ──
    const existing = getUserByWallet(eoaKey);
    if (existing) {
      console.log(`  Found existing mapping: entity=${existing.entity_id} account=${existing.account_id}`);
      try {
        await client.v2.accounts.retrieve(existing.account_id);

        const verification = await verifyWalletConnected(client, existing.account_id);
        if (verification.connected) {
          console.log(`  Wallet already connected: ${verification.wallet?.address} chain=${verification.wallet?.chain_id}`);
          return res.json({
            accountId: existing.account_id,
            entityId: existing.entity_id,
            smartWalletAddress,
            walletConnected: true,
            alreadySetup: true,
          });
        }

        console.log('  No wallet connected yet – generating nonce...');
        const nonceResp = await getNonceForWallet(
          client,
          existing.account_id,
          eoaAddress,
          smartWalletAddress,
        );
        console.log(`  Nonce ready: wallet=${nonceResp.walletAddress} chain=${nonceResp.walletChainId}`);
        return res.json({
          accountId: existing.account_id,
          entityId: existing.entity_id,
          smartWalletAddress,
          nonce: nonceResp.nonce,
          message: nonceResp.message,
          walletAddressToConnect: nonceResp.walletAddress,
          walletChainId: nonceResp.walletChainId,
          walletConnected: false,
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

    const nonceResp = await getNonceForWallet(client, account.id, eoaAddress, smartWalletAddress);
    console.log(`  Nonce ready: wallet=${nonceResp.walletAddress} chain=${nonceResp.walletChainId}`);

    saveUser(eoaKey, ORG_ENTITY_ID, account.id);

    res.json({
      accountId: account.id,
      entityId: ORG_ENTITY_ID,
      smartWalletAddress,
      nonce: nonceResp.nonce,
      message: nonceResp.message,
      walletAddressToConnect: nonceResp.walletAddress,
      walletChainId: nonceResp.walletChainId,
      walletConnected: false,
      alreadySetup: false,
    });
  } catch (error: any) {
    console.error('Setup Error:', error.message || error);
    res.status(500).json({ error: 'Failed to setup Dinari account', details: error.message });
  }
});

// ── CONNECT WALLET: Submit signed nonce ───────────────────────────────────────
router.post('/connect-wallet', async (req, res) => {
  try {
    const { accountId, nonce, signature, walletAddress, walletChainId } = req.body;
    if (!accountId || !nonce || !signature || !walletAddress) {
      return res.status(400).json({ error: 'accountId, nonce, signature, walletAddress required' });
    }

    const checksumAddr = toChecksumAddress(walletAddress);
    const cleanSig = cleanSignature(signature);
    const chainId = (walletChainId || WALLET_CHAIN_ID) as any;

    console.log(`\n=== CONNECT WALLET ===`);
    console.log(`  accountId:  ${accountId}`);
    console.log(`  address:    ${checksumAddr}`);
    console.log(`  chainId:    ${chainId}`);
    console.log(`  nonce:      ${nonce}`);
    console.log(`  sig length: ${cleanSig.length} chars`);
    console.log(`  sig prefix: ${cleanSig.slice(0, 10)}...`);

    const client = getDinariClient();

    const linkedWallet = await client.v2.accounts.wallet.external.connect(accountId, {
      chain_id: chainId,
      nonce,
      signature: cleanSig,
      wallet_address: checksumAddr,
    });
    console.log(`  SDK connect returned: address=${linkedWallet.address} chain=${linkedWallet.chain_id} managed=${linkedWallet.is_managed_wallet} aml=${linkedWallet.is_aml_flagged}`);

    // Verify the wallet is actually stored by reading it back
    const verification = await verifyWalletConnected(client, accountId);
    console.log(`  Post-connect verification: connected=${verification.connected} wallet=${verification.wallet?.address ?? 'none'}`);

    if (!verification.connected) {
      console.error('  WARNING: SDK returned success but wallet.get() shows no wallet!');
    }

    // Auto-mint sandbox tokens so the account is funded
    try {
      await client.v2.accounts.mintSandboxTokens(accountId, { chain_id: ORDER_CHAIN_ID as any });
      console.log('  Faucet minted after wallet connection');
    } catch (faucetErr: any) {
      console.warn('  Faucet mint after connect failed (non-fatal):', faucetErr.message);
    }

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

    let quote: any = null;
    try { quote = await client.v2.marketData.stocks.retrieveCurrentQuote(match.id); } catch (_) {}

    res.json({
      tradeable: true,
      ticker,
      dinariTicker: match.ticker,
      stockId: match.id,
      name: match.name,
      tokenAddress: match.token_address,
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

    // Create the EIP-712 permit for the Dinari-sponsored flow
    const permitResponse = await client.v2.accounts.orderRequests.eip155.createPermit(user.account_id, {
      chain_id: ORDER_CHAIN_ID as any,
      order_side: 'BUY',
      order_tif: 'DAY',
      order_type: 'MARKET',
      stock_id: actualStockId,
      payment_token: PAYMENT_TOKEN,
      payment_token_quantity: parseFloat(paymentAmount),
    });

    res.json({
      permit: permitResponse.permit,
      orderRequestId: permitResponse.order_request_id,
      accountId: user.account_id,
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

    const permitResponse = await client.v2.accounts.orderRequests.eip155.createPermit(user.account_id, {
      chain_id: ORDER_CHAIN_ID as any,
      order_side: 'SELL',
      order_tif: 'DAY',
      order_type: 'MARKET',
      stock_id: actualStockId,
      payment_token: PAYMENT_TOKEN,
      asset_token_quantity: parseFloat(assetQuantity),
    });

    res.json({
      permit: permitResponse.permit,
      orderRequestId: permitResponse.order_request_id,
      accountId: user.account_id,
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
    await client.v2.accounts.mintSandboxTokens(user.account_id, { chain_id: ORDER_CHAIN_ID as any });
    res.json({ success: true, message: 'Sandbox tokens minted on ' + ORDER_CHAIN_ID });
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
router.get('/payment-token', async (_req, res) => {
  res.json({ address: PAYMENT_TOKEN, chain: ORDER_CHAIN_ID });
});

// ── DEBUG: Check API key health & wallet status ──────────────────────────────
router.get('/debug/health', async (_req, res) => {
  const results: Record<string, any> = {
    apiKeyId: (process.env['DINARI_API_ID'] || '').slice(0, 12) + '...',
    environment: process.env['DINARI_ENVIRONMENT'] || 'sandbox',
    orderChainId: ORDER_CHAIN_ID,
    paymentToken: PAYMENT_TOKEN,
    walletChainId: WALLET_CHAIN_ID,
    smartWalletChainId: SMART_WALLET_CHAIN_ID,
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
