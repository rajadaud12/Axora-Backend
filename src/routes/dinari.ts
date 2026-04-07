import { Router } from 'express';
import Dinari from '@dinari/api-sdk';
import axios from 'axios';
import { getUserByWallet, saveUser } from '../db';

const router = Router();

// ── Dinari SDK Client ─────────────────────────────────────────────────────────
const getDinariClient = () => {
  return new Dinari({
    apiKeyID: process.env['DINARI_API_ID'] || '',
    apiSecretKey: process.env['DINARI_API_SECRET'] || '',
    environment: (process.env['DINARI_ENVIRONMENT'] as 'sandbox' | 'production') || 'sandbox',
  });
};

// ── Helper: Resolve stock ticker to ID ────────────────────────────────────────
async function resolveStockId(client: Dinari, tickerOrId: string): Promise<string> {
  if (tickerOrId.includes('-')) return tickerOrId;
  
  if (cachedStocks.length === 0) {
    const stocks = await client.v2.marketData.stocks.list();
    cachedStocks = stocks.map((s: any) => ({
      id: s.id,
      ticker: s.symbol || s.ticker || s.stock_ticker || '',
      name: s.name || '',
      is_active: s.is_active,
      token_address: s.token?.address || '',
      token_chain: s.token?.chain_id || '',
    }));
    lastStockFetch = Date.now();
  }
  
  const stock = cachedStocks.find(s => s.ticker.toUpperCase() === tickerOrId.toUpperCase());
  if (!stock) {
    throw new Error(`Stock ID not found for ticker: ${tickerOrId}`);
  }
  return stock.id;
}


// Sandbox chain ID for Arbitrum Sepolia
const CHAIN_ID = 'eip155:421614';

// Payment token address for sandbox (USD+ or USDC equivalent on Dinari sandbox)
// This will be determined when we query stock data - Dinari provides it
let cachedPaymentToken: string | null = null;

// Cache for stocks (refresh every 5 minutes)
let cachedStocks: any[] = [];
let lastStockFetch = 0;

// ── SETUP: Create Entity + Account ────────────────────────────────────────────
router.post('/setup', async (req, res) => {
  try {
    const { walletAddress } = req.body;
    if (!walletAddress) {
      return res.status(400).json({ error: 'walletAddress is required' });
    }

    const wallet = walletAddress.toLowerCase();

    // Check if user already exists
    const existing = getUserByWallet(wallet);
    if (existing) {
      // User exists, get nonce for wallet reconnection if needed
      const client = getDinariClient();
      try {
        const nonceResp = await client.v2.accounts.wallet.external.getNonce(existing.account_id, {
          chain_id: CHAIN_ID as any,
          wallet_address: wallet,
        });
        return res.json({
          accountId: existing.account_id,
          entityId: existing.entity_id,
          nonce: nonceResp.nonce,
          message: nonceResp.message,
          alreadySetup: true,
        });
      } catch (e: any) {
        // Wallet might already be connected, return existing data
        return res.json({
          accountId: existing.account_id,
          entityId: existing.entity_id,
          alreadySetup: true,
          walletConnected: true,
        });
      }
    }

    // Create new entity + account
    const client = getDinariClient();

    // 1. Create Entity
    const entity = await client.v2.entities.create({
      name: `Axora-${wallet.slice(0, 8)}`,
    });
    console.log('Created Dinari Entity:', entity.id);

    // 2. Submit sandbox KYC (auto-approved)
    try {
      await client.v2.entities.kyc.submit(entity.id, {
        data: {
          country_code: 'US',
          address_country_code: 'US',
          first_name: 'Axora',
          last_name: `User-${wallet.slice(2, 8)}`,
          birth_date: '1990-01-01',
          email: `${wallet.slice(2, 10)}@axora.app`,
          tax_id_number: '000-00-0000',
          address_street_1: '123 Blockchain Ave',
          address_city: 'San Francisco',
          address_subdivision: 'California',
          address_postal_code: '94105',
        },
        provider_name: '',
      });
      console.log('KYC submitted for entity:', entity.id);
    } catch (kycErr: any) {
      console.log('KYC submission note:', kycErr.message || 'auto-approved in sandbox');
    }

    // 3. Create Account
    const account = await client.v2.entities.accounts.create(entity.id);
    console.log('Created Dinari Account:', account.id);

    // 4. Save to SQLite
    saveUser(wallet, entity.id, account.id);

    // 5. Get nonce for wallet connection
    const nonceResp = await client.v2.accounts.wallet.external.getNonce(account.id, {
      chain_id: CHAIN_ID as any,
      wallet_address: wallet,
    });

    res.json({
      accountId: account.id,
      entityId: entity.id,
      nonce: nonceResp.nonce,
      message: nonceResp.message,
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
    const { accountId, nonce, signature, walletAddress } = req.body;
    if (!accountId || !nonce || !signature || !walletAddress) {
      return res.status(400).json({ error: 'accountId, nonce, signature, walletAddress required' });
    }

    const client = getDinariClient();
    const linkedWallet = await client.v2.accounts.wallet.external.connect(accountId, {
      chain_id: CHAIN_ID as any,
      nonce,
      signature,
      wallet_address: walletAddress.toLowerCase(),
    });

    console.log('Wallet connected:', linkedWallet);
    res.json({ success: true, wallet: linkedWallet });
  } catch (error: any) {
    console.error('Connect Wallet Error:', error.message || error);
    res.status(500).json({ error: 'Failed to connect wallet', details: error.message });
  }
});

// ── STOCKS: List tradeable dShare stocks ──────────────────────────────────────
router.get('/stocks', async (_req, res) => {
  try {
    const now = Date.now();
    if (cachedStocks.length > 0 && now - lastStockFetch < 5 * 60 * 1000) {
      return res.json({ stocks: cachedStocks });
    }

    const client = getDinariClient();
    const stocks = await client.v2.marketData.stocks.list();

    cachedStocks = stocks.map((s: any) => ({
      id: s.id,
      ticker: s.symbol || s.ticker || s.stock_ticker || '',
      name: s.name || '',
      is_active: s.is_active,
      token_address: s.token?.address || '',
      token_chain: s.token?.chain_id || '',
    }));
    lastStockFetch = now;

    res.json({ stocks: cachedStocks });
  } catch (error: any) {
    console.error('Stocks Error:', error.message || error);
    res.status(500).json({ error: 'Failed to fetch stocks', details: error.message });
  }
});

// ── STOCK QUOTE ───────────────────────────────────────────────────────────────
router.get('/stocks/:id/quote', async (req, res) => {
  try {
    const { id } = req.params;
    const client = getDinariClient();
    const quote = await client.v2.marketData.stocks.retrieveCurrentQuote(id);
    res.json(quote);
  } catch (error: any) {
    console.error('Quote Error:', error.message || error);
    res.status(500).json({ error: 'Failed to get quote', details: error.message });
  }
});

// ── PREPARE BUY ORDER (EIP-712 Permit) ────────────────────────────────────────
router.post('/order/prepare-buy', async (req, res) => {
  try {
    const { walletAddress, stockId, paymentAmount } = req.body;
    if (!walletAddress || !stockId || !paymentAmount) {
      return res.status(400).json({ error: 'walletAddress, stockId, paymentAmount required' });
    }

    const wallet = walletAddress.toLowerCase();
    const user = getUserByWallet(wallet);
    if (!user) {
      return res.status(404).json({ error: 'User not set up. Call /setup first.' });
    }

    const client = getDinariClient();

    // Get payment token for the chain
    const paymentToken = await getPaymentToken(client);
    
    // Resolve Stock ID
    const actualStockId = await resolveStockId(client, stockId);

    const permitResponse = await client.v2.accounts.orderRequests.eip155.createPermit(user.account_id, {
      chain_id: CHAIN_ID as any,
      order_side: 'BUY',
      order_tif: 'DAY',
      order_type: 'MARKET',
      stock_id: actualStockId,
      payment_token: paymentToken,
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

// ── PREPARE SELL ORDER (EIP-712 Permit) ───────────────────────────────────────
router.post('/order/prepare-sell', async (req, res) => {
  try {
    const { walletAddress, stockId, assetQuantity } = req.body;
    if (!walletAddress || !stockId || !assetQuantity) {
      return res.status(400).json({ error: 'walletAddress, stockId, assetQuantity required' });
    }

    const wallet = walletAddress.toLowerCase();
    const user = getUserByWallet(wallet);
    if (!user) {
      return res.status(404).json({ error: 'User not set up. Call /setup first.' });
    }

    const client = getDinariClient();
    const paymentToken = await getPaymentToken(client);
    
    // Resolve Stock ID
    const actualStockId = await resolveStockId(client, stockId);

    const permitResponse = await client.v2.accounts.orderRequests.eip155.createPermit(user.account_id, {
      chain_id: CHAIN_ID as any,
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
    });
  } catch (error: any) {
    console.error('Prepare Sell Error:', error.message || error);
    res.status(500).json({ error: 'Failed to prepare sell order', details: error.message });
  }
});

// ── SUBMIT ORDER (Dinari-sponsored) ───────────────────────────────────────────
router.post('/order/submit', async (req, res) => {
  try {
    const { accountId, orderRequestId, permitSignature } = req.body;
    if (!accountId || !orderRequestId || !permitSignature) {
      return res.status(400).json({ error: 'accountId, orderRequestId, permitSignature required' });
    }

    const client = getDinariClient();
    const result = await client.v2.accounts.orderRequests.eip155.submit(accountId, {
      order_request_id: orderRequestId,
      permit_signature: permitSignature,
    });

    res.json({
      success: true,
      order: result,
    });
  } catch (error: any) {
    console.error('Submit Order Error:', error.message || error);
    res.status(500).json({ error: 'Failed to submit order', details: error.message });
  }
});

// ── PORTFOLIO: Read dShare balances via Alchemy ───────────────────────────────
router.get('/portfolio/:walletAddress', async (req, res) => {
  try {
    const { walletAddress } = req.params;
    const wallet = walletAddress.toLowerCase();

    // Get dShare token addresses from cached stocks
    if (cachedStocks.length === 0) {
      const client = getDinariClient();
      const stocks = await client.v2.marketData.stocks.list();
      cachedStocks = stocks.map((s: any) => ({
        id: s.id,
        ticker: s.symbol || s.ticker || s.stock_ticker || '',
        name: s.name || '',
        is_active: s.is_active,
        token_address: s.token?.address || '',
        token_chain: s.token?.chain_id || '',
      }));
      lastStockFetch = Date.now();
    }

    // Filter stocks that have token addresses on our chain
    const dShareTokens = cachedStocks
      .filter(s => s.token_address && s.token_address.startsWith('0x'))
      .map(s => s.token_address);

    if (dShareTokens.length === 0) {
      return res.json({ holdings: [] });
    }

    // Use Alchemy to get token balances
    const alchemyRpcUrl = process.env['ALCHEMY_RPC_URL'] || 'https://arb-sepolia.g.alchemy.com/v2/demo';
    const balanceResponse = await axios.post(alchemyRpcUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'alchemy_getTokenBalances',
      params: [wallet, dShareTokens],
    }, { timeout: 10000 });

    const tokenBalances = balanceResponse.data?.result?.tokenBalances || [];
    const holdings: any[] = [];

    for (const tb of tokenBalances) {
      // Skip zero balances
      const rawBalance = BigInt(tb.tokenBalance || '0');
      if (rawBalance === 0n) continue;

      // Find matching stock
      const stock = cachedStocks.find(
        s => s.token_address.toLowerCase() === tb.contractAddress.toLowerCase()
      );
      if (!stock) continue;

      // dShare tokens have 18 decimals
      const balance = Number(rawBalance) / 1e18;

      holdings.push({
        ticker: stock.ticker,
        name: stock.name,
        stockId: stock.id,
        tokenAddress: stock.token_address,
        balance: balance,
      });
    }

    res.json({ holdings });
  } catch (error: any) {
    console.error('Portfolio Error:', error.message || error);
    res.status(500).json({ error: 'Failed to fetch portfolio', details: error.message });
  }
});

// ── ORDERS: List order history ────────────────────────────────────────────────
router.get('/orders/:walletAddress', async (req, res) => {
  try {
    const { walletAddress } = req.params;
    const wallet = walletAddress.toLowerCase();
    const user = getUserByWallet(wallet);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const client = getDinariClient();
    const orders = await client.v2.accounts.orderRequests.list(user.account_id);

    res.json({
      orders: orders.map((o: any) => ({
        id: o.id,
        stock_id: o.stock_id,
        order_side: o.order_side,
        order_type: o.order_type,
        status: o.status,
        payment_amount: o.payment_amount,
        asset_quantity: o.asset_quantity,
        created_at: o.created_at,
      })),
    });
  } catch (error: any) {
    console.error('Orders Error:', error.message || error);
    res.status(500).json({ error: 'Failed to fetch orders', details: error.message });
  }
});

// ── FAUCET: Mint sandbox tokens ───────────────────────────────────────────────
router.post('/faucet/:walletAddress', async (req, res) => {
  try {
    const { walletAddress } = req.params;
    const wallet = walletAddress.toLowerCase();
    const user = getUserByWallet(wallet);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const client = getDinariClient();
    await client.v2.accounts.mintSandboxTokens(user.account_id, {
      chain_id: CHAIN_ID as any,
    });

    res.json({ success: true, message: 'Sandbox tokens minted' });
  } catch (error: any) {
    console.error('Faucet Error:', error.message || error);
    res.status(500).json({ error: 'Failed to mint tokens', details: error.message });
  }
});

// ── USER INFO: Get account ID for a wallet ────────────────────────────────────
router.get('/user/:walletAddress', async (req, res) => {
  try {
    const { walletAddress } = req.params;
    const user = getUserByWallet(walletAddress.toLowerCase());
    if (!user) {
      return res.json({ setup: false });
    }
    res.json({
      setup: true,
      accountId: user.account_id,
      entityId: user.entity_id,
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// ── Helper: Get payment token for the chain ───────────────────────────────────
async function getPaymentToken(client: Dinari): Promise<string> {
  if (cachedPaymentToken) return cachedPaymentToken;

  // In Dinari sandbox on Arbitrum Sepolia, USD+ is the payment token
  // We can get it from the stocks list or use a known address
  // The Dinari SDK should provide this, but as a fallback we use a known sandbox address
  try {
    // Try to get from Dinari's supported tokens/chains info
    // For sandbox Arbitrum Sepolia, the payment token is typically USD+
    // Known sandbox payment token: 0x6a34FDFE60D1758dF5b577d413E37397D21c3E78 (USD+ on Arb Sepolia)
    cachedPaymentToken = '0x6a34FDFE60D1758dF5b577d413E37397D21c3E78';
    return cachedPaymentToken;
  } catch (e) {
    // Fallback
    return '0x6a34FDFE60D1758dF5b577d413E37397D21c3E78';
  }
}

export default router;
