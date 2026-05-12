const crypto = require('crypto');

const PASSWORD_ALGORITHM = 'pbkdf2_sha256';
const PASSWORD_ITERATIONS = 310000;
const PASSWORD_KEY_LENGTH = 32;
const TOKEN_TTL_SECONDS = Number.parseInt(process.env.SESSION_TTL_SECONDS || '86400', 10);
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.API_TOKEN || 'virtualwebcam-dev-session-secret';

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function fromBase64url(input) {
  const normalized = String(input).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function sign(value) {
  return base64url(crypto.createHmac('sha256', SESSION_SECRET).update(value).digest());
}

function timingSafeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));

  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(
    String(password),
    salt,
    PASSWORD_ITERATIONS,
    PASSWORD_KEY_LENGTH,
    'sha256',
  ).toString('hex');

  return `${PASSWORD_ALGORITHM}$${PASSWORD_ITERATIONS}$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  const [algorithm, iterationsText, salt, expectedHash] = String(storedHash || '').split('$');

  if (algorithm !== PASSWORD_ALGORITHM || !salt || !expectedHash) {
    return false;
  }

  const iterations = Number.parseInt(iterationsText, 10);
  if (!Number.isInteger(iterations) || iterations < 100000) {
    return false;
  }

  const actualHash = crypto.pbkdf2Sync(
    String(password),
    salt,
    iterations,
    PASSWORD_KEY_LENGTH,
    'sha256',
  ).toString('hex');

  return timingSafeEqual(actualHash, expectedHash);
}

function publicUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name || user.username,
    role: user.role === 'admin' ? 'admin' : 'user',
    enabled: Boolean(user.enabled),
    is_service: Boolean(user.is_service),
  };
}

function createToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: user.id,
    username: user.username,
    role: user.role,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };
  const body = base64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

function verifyToken(token) {
  const [body, signature] = String(token || '').split('.');

  if (!body || !signature || !timingSafeEqual(signature, sign(body))) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64url(body));
    const now = Math.floor(Date.now() / 1000);

    if (!payload.sub || !payload.exp || payload.exp < now) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

module.exports = {
  TOKEN_TTL_SECONDS,
  createToken,
  hashPassword,
  publicUser,
  verifyPassword,
  verifyToken,
};
