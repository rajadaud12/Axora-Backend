import { Router } from 'express';
import axios from 'axios';

const router = Router();

router.get('/assets', async (req, res) => {
  try {
    const symbols = req.query.symbols as string;
    if (!symbols) {
      return res.status(400).json({ error: 'Missing symbols query parameter' });
    }

    const response = await axios.get('https://query1.finance.yahoo.com/v7/finance/spark', {
      params: {
        symbols,
        range: '1d',
        interval: '1d',
        indicators: 'close',
      },
    });

    res.json(response.data);
  } catch (error: any) {
    if (axios.isAxiosError(error)) {
      console.error('Yahoo Assets Error HTTP', error.response?.status, error.response?.data || error.message);
    } else {
      console.error('Yahoo Assets Error:', error);
    }
    res.status(500).json({ error: 'Failed to fetch market data' });
  }
});

router.get('/details/:ticker', async (req, res) => {
  try {
    const { ticker } = req.params;
    const response = await axios.get('https://query1.finance.yahoo.com/v7/finance/quote', {
      params: { symbols: ticker },
    });
    res.json(response.data);
  } catch (error: any) {
    if (axios.isAxiosError(error)) {
      console.error('Yahoo Details Error HTTP', error.response?.status, error.response?.data || error.message);
    } else {
      console.error('Yahoo Details Error:', error);
    }
    res.status(500).json({ error: 'Failed to fetch ticker details' });
  }
});

router.get('/chart/:ticker', async (req, res) => {
  try {
    const { ticker } = req.params;
    const { range = '1mo', interval = '1d' } = req.query;

    const response = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}`, {
      params: { range, interval },
    });
    res.json(response.data);
  } catch (error: any) {
    if (axios.isAxiosError(error)) {
      console.error('Yahoo Chart Error HTTP', error.response?.status, error.response?.data || error.message);
    } else {
      console.error('Yahoo Chart Error:', error);
    }
    res.status(500).json({ error: 'Failed to fetch chart data' });
  }
});

export default router;
