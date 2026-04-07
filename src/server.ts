import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import marketRoutes from './routes/market';
import earnRoutes from './routes/earn';
import dinariRoutes from './routes/dinari';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/api/market', marketRoutes);
app.use('/api/earn', earnRoutes);
app.use('/api/dinari', dinariRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const server = app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});

server.on('error', (error: any) => {
  if (error.syscall !== 'listen') {
    throw error;
  }
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Please kill the process using it or change the port.`);
    process.exit(1);
  } else {
    console.error('Server error:', error);
  }
});
