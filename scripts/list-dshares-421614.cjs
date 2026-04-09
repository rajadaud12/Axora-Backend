require('dotenv').config();
const Dinari = require('@dinari/api-sdk').default;

const TARGET = 'eip155:421614';

(async () => {
  const client = new Dinari({
    apiKeyID: process.env.DINARI_API_ID || '',
    apiSecretKey: process.env.DINARI_API_SECRET || '',
    environment: process.env.DINARI_ENVIRONMENT || 'sandbox',
  });
  const stocks = await client.v2.marketData.stocks.list();
  const rows = [];
  for (const s of stocks) {
    const tokens = Array.isArray(s.tokens) ? s.tokens : [];
    for (const caip10 of tokens) {
      const parts = String(caip10).split(':');
      if (parts.length < 3) continue;
      const chain = `${parts[0]}:${parts[1]}`;
      if (chain !== TARGET) continue;
      const addr = parts.slice(2).join(':');
      const ticker = String(s.symbol || s.stock_ticker || s.ticker || '').toUpperCase();
      rows.push({ ticker, stockId: s.id, tokenAddress: addr });
      break;
    }
  }
  rows.sort((a, b) => a.ticker.localeCompare(b.ticker));
  console.log(JSON.stringify(rows, null, 2));
  console.error(`Total dShares on ${TARGET}: ${rows.length}`);
})();
