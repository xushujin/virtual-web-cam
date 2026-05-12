require('dotenv').config();

const cors = require('cors');
const express = require('express');
const morgan = require('morgan');
const { initDb, getDb } = require('./db');
const { publicUser, verifyToken } = require('./auth');
const routes = require('./routes');

const PORT = Number.parseInt(process.env.PORT || '8177', 10);
const API_TOKEN = process.env.API_TOKEN || '';

function apiTokenMatches(req) {
  const headerToken = req.get('x-api-token');
  const authHeader = req.get('authorization') || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  return Boolean(API_TOKEN && (headerToken === API_TOKEN || bearerToken === API_TOKEN));
}

async function requireAuth(req, res, next) {
  if (req.path === '/auth/login') {
    return next();
  }

  if (apiTokenMatches(req)) {
    req.user = publicUser({
      id: null,
      username: 'api-token',
      display_name: 'API Token',
      role: 'admin',
      enabled: 1,
      is_service: true,
    });
    return next();
  }

  const authHeader = req.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const payload = verifyToken(token);

  if (!payload) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const user = await getDb().get(
      'SELECT id, username, display_name, role, enabled FROM users WHERE id = ?',
      payload.sub,
    );

    if (!user || !user.enabled) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    req.user = publicUser(user);
    return next();
  } catch (error) {
    return next(error);
  }
}

async function main() {
  await initDb();

  const app = express();

  app.use(cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((item) => item.trim()) : true,
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(morgan('combined'));
  app.use('/api', requireAuth);
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
