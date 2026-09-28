/**
 * gate.js — the sign-in wall.
 *
 * Runs on Netlify's edge in front of every request, before any file is
 * served. No valid session, no dashboard.
 *
 * Runs on Deno, so it uses Web Crypto. It only verifies the session token —
 * passwords and MongoDB live in netlify/functions/auth.js.
 */

const COOKIE = '__Host-cg_session';

/** Reachable while signed out, or nobody could ever sign in. */
const PUBLIC = new Set([
  '/login',
  '/login.html',
  '/.netlify/functions/auth',
  '/favicon.ico',
  '/robots.txt',
]);

export const config = { path: '/*' };

export default async function gate(request, context) {
  const url = new URL(request.url);
  if (PUBLIC.has(url.pathname)) return context.next();

  const secret = Netlify.env.get('AUTH_JWT_SECRET');

  // Fail closed: a misconfigured site locks everyone out, never lets everyone in.
  if (!secret) {
    return new Response('Sign-in is not configured (AUTH_JWT_SECRET missing).', {
      status: 503,
      headers: { 'content-type': 'text/plain' },
    });
  }

  const session = await verifyToken(getCookie(request), secret);
  if (!session) {
    const next = encodeURIComponent(url.pathname + url.search);
    return redirect(url, `/login?next=${next}`);
  }

  // Signed in but missing this dashboard's role — a different situation from
  // signed out, so login.html shows its no-access state instead of the form.
  // The site key is this deployment's name for itself (governance, kb, ops,
  // financials) and never contains anything personal, so it is safe in a URL.
  const siteKey = Netlify.env.get('SITE_KEY') || '';
  if (siteKey && !hasAccess(session, siteKey)) {
    return redirect(url, `/login?denied=${encodeURIComponent(siteKey)}`);
  }

  const response = await context.next();
  response.headers.set('cache-control', 'private, no-store');
  return response;
}

function hasAccess(session, siteKey) {
  const roles = (session.roles || []).map((role) => String(role).toLowerCase());
  return roles.includes(siteKey);
}

const redirect = (url, path) => Response.redirect(new URL(path, url.origin), 302);

function getCookie(request) {
  const header = request.headers.get('cookie') || '';
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq > -1 && pair.slice(0, eq).trim() === COOKIE) return pair.slice(eq + 1).trim();
  }
  return '';
}

function decode(segment) {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const asText = (bytes) => new TextDecoder().decode(bytes);
const asBytes = (text) => new TextEncoder().encode(text);

async function verifyToken(token, secret) {
  const [header, payload, signature] = String(token).split('.');
  if (!header || !payload || !signature) return null;

  // Only ever HS256. Taking the algorithm from the token itself is the
  // alg-confusion hole that lets an attacker forge a session.
  try {
    if (JSON.parse(asText(decode(header))).alg !== 'HS256') return null;
  } catch {
    return null;
  }

  const key = await crypto.subtle.importKey(
    'raw', asBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'HMAC', key, decode(signature), asBytes(`${header}.${payload}`),
  );
  if (!valid) return null;

  let claims;
  try {
    claims = JSON.parse(asText(decode(payload)));
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  return typeof claims.exp === 'number' && claims.exp >= now ? claims : null;
}
