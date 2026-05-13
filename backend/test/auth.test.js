const assert = require('node:assert/strict');
const test = require('node:test');

process.env.SESSION_SECRET = 'unit-test-session-secret';

const {
  createToken,
  hashPassword,
  publicUser,
  verifyPassword,
  verifyToken,
} = require('../src/auth');

test('hashPassword creates verifiable PBKDF2 hashes', () => {
  const hash = hashPassword('strong-password');

  assert.match(hash, /^pbkdf2_sha256\$310000\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.equal(verifyPassword('strong-password', hash), true);
  assert.equal(verifyPassword('wrong-password', hash), false);
});

test('verifyPassword rejects malformed or weak stored hashes', () => {
  assert.equal(verifyPassword('password', ''), false);
  assert.equal(verifyPassword('password', 'sha1$1$salt$hash'), false);
  assert.equal(verifyPassword('password', 'pbkdf2_sha256$999$salt$hash'), false);
});

test('createToken and verifyToken round trip a user session', () => {
  const token = createToken({
    id: 42,
    username: 'operator',
    role: 'user',
  });

  const payload = verifyToken(token);
  assert.equal(payload.sub, 42);
  assert.equal(payload.username, 'operator');
  assert.equal(payload.role, 'user');
  assert.equal(typeof payload.exp, 'number');
});

test('verifyToken rejects tampered tokens', () => {
  const token = createToken({
    id: 1,
    username: 'admin',
    role: 'admin',
  });
  const [body, signature] = token.split('.');
  const tamperedBody = Buffer.from(JSON.stringify({
    sub: 999,
    username: 'admin',
    role: 'admin',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');

  assert.equal(verifyToken(`${tamperedBody}.${signature}`), null);
  assert.equal(verifyToken(`${body}.bad-signature`), null);
});

test('publicUser normalizes safe user fields', () => {
  assert.deepEqual(publicUser({
    id: 7,
    username: 'viewer',
    display_name: '',
    role: 'viewer',
    enabled: 1,
  }), {
    id: 7,
    username: 'viewer',
    display_name: 'viewer',
    role: 'user',
    enabled: true,
    is_service: false,
  });

  assert.equal(publicUser(null), null);
});
