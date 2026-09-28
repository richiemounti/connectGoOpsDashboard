const { createHmac, timingSafeEqual, scrypt, randomBytes } = require('node:crypto');
const { promisify } = require('node:util');
const { MongoClient } = require('mongodb');

const scryptAsync = promisify(scrypt);
const COOKIE = '__Host-cg_session';
const SESSION_SECONDS = Number(process.env.AUTH_SESSION_SECONDS || 43200);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;
let client;

function json(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
    body: JSON.stringify(body),
  };
}

async function users() {
  if (!client) {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
    client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 5, serverSelectionTimeoutMS: 7000 });
    await client.connect();
  }
  return client.db(process.env.MONGODB_DB || 'connectgo').collection('users');
}

const encode = value => Buffer.from(value).toString('base64url');
const decode = value => Buffer.from(value, 'base64url');

function signToken(claims) {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('AUTH_JWT_SECRET must be at least 32 characters');
  const now = Math.floor(Date.now() / 1000);
  const header = encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = encode(JSON.stringify({ ...claims, iat: now, exp: now + SESSION_SECONDS }));
  const signature = encode(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

function verifyToken(token) {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret || !token) return null;
  const [header, payload, signature] = String(token).split('.');
  if (!header || !payload || !signature) return null;
  try {
    if (JSON.parse(decode(header).toString()).alg !== 'HS256') return null;
    const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
    const actual = decode(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    const claims = JSON.parse(decode(payload).toString());
    return typeof claims.exp === 'number' && claims.exp >= Math.floor(Date.now() / 1000) ? claims : null;
  } catch {
    return null;
  }
}

function getCookie(event) {
  const raw = event.headers?.cookie || event.headers?.Cookie || '';
  for (const pair of raw.split(';')) {
    const index = pair.indexOf('=');
    if (index > -1 && pair.slice(0, index).trim() === COOKIE) return pair.slice(index + 1).trim();
  }
  return '';
}

function setCookie(token, maxAge) {
  return [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', `Max-Age=${maxAge}`].join('; ');
}

function checkPassword(password, stored) {
  if (typeof stored !== 'string') return Promise.resolve(false);
  const [scheme, N, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return Promise.resolve(false);
  const expected = Buffer.from(hash, 'base64');
  return scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem })
    .then(value => {
      const actual = Buffer.from(value);
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    })
    .catch(() => false);
}

function isLockedOut(user) {
  return Boolean(user && (user.failed_attempts || 0) >= MAX_ATTEMPTS && Date.now() - new Date(user.last_failed_at || 0).getTime() < LOCKOUT_MS);
}

const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

async function validPassword(user, password) {
  const matches = await checkPassword(password, user?.password_hash || DUMMY_HASH);
  return matches && Boolean(user) && user.active !== false;
}

async function recordLogin(collection, email, user, valid) {
  try {
    if (valid) await collection.updateOne({ email }, { $set: { failed_attempts: 0, last_login_at: new Date() } });
    else if (user) await collection.updateOne({ email }, { $inc: { failed_attempts: 1 }, $set: { last_failed_at: new Date() } });
  } catch (error) {
    console.error('Could not save sign-in attempt:', error.message);
  }
}

function parseBody(event) {
  try { return event.body ? JSON.parse(event.body) : {}; } catch { return null; }
}

function hasDashboardRole(session, requiredRole = process.env.SITE_KEY) {
  const roles = (session?.roles || []).map(role => String(role).toLowerCase());
  return !requiredRole || roles.includes('admin') || roles.includes(requiredRole);
}

function requireUser(event, requiredRole = process.env.SITE_KEY) {
  const session = verifyToken(getCookie(event));
  return session && hasDashboardRole(session, requiredRole) ? session : null;
}

function unauthorized() { return json(401, { error: 'Not authorised' }); }

exports.requireUser = requireUser;
exports.unauthorized = unauthorized;

exports.handler = async event => {
  const action = event.queryStringParameters?.action;

  if (action === 'logout') {
    return {
      statusCode: 302,
      headers: { location: '/login.html?signed_out=1', 'cache-control': 'no-store', 'set-cookie': setCookie('', 0) },
      body: '',
    };
  }

  if (action !== 'login' || event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = parseBody(event);
  if (!body) return json(400, { error: 'Expected valid JSON' });

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) return json(400, { error: 'Email and password are required' });

  try {
    const collection = await users();
    const user = await collection.findOne({ email });
    if (isLockedOut(user)) return json(429, { error: 'Too many failed attempts. Try again in 15 minutes.' });
    const valid = await validPassword(user, password);
    await recordLogin(collection, email, user, valid);
    if (!valid) return json(401, { error: 'Incorrect email or password' });

    const token = signToken({ sub: String(user._id), email: user.email, name: user.name || null, roles: user.roles || [] });
    return json(200, { ok: true }, { 'set-cookie': setCookie(token, SESSION_SECONDS) });
  } catch (error) {
    console.error('Sign-in unavailable:', error.message);
    return json(503, { error: 'Sign-in is temporarily unavailable' });
  }
};
