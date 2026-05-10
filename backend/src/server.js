require('dotenv').config();

const cors = require('cors');
const express = require('express');
const morgan = require('morgan');
const { initDb } = require('./db');
const routes = require('./routes');

const PORT = Number.parseInt(process.env.PORT || '8177', 10);
const API_TOKEN = process.env.API_TOKEN || '';

function requireApiToken(req, res, next) {
  if (!API_TOKEN) {
    return next();
  }

  const headerToken = req.get('x-api-token');
  const authHeader = req.get('authorization') || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (headerToken === API_TOKEN || bearerToken === API_TOKEN) {
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized' });
}

async function main() {
  await initDb();

  const app = express();

  app.use(cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((item) => item.trim()) : true,
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan('combined'));
  app.use('/api', requireApiToken);
  app.use('/api', routes);

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }
    return res.status(500).json({ error: error.message || String(error) });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`VirtualWebCam API listening on :${PORT}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
