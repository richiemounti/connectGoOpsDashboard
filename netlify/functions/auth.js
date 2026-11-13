// Holiday records are always scoped to the signed-in Operations account.
async function manageStreakLeave(event) {
  const session = await requireUser(event, "ops");
  if (!session) return unauthorized();
  const collection = await users();
  const email = session.email;
  let member = await collection.findOne({ email });
  if (!member) return unauthorized();
  if (!["GET", "POST"].includes(event.httpMethod))
    return json(405, { error: "Method not allowed" });
  if (event.httpMethod === "POST") {
    if (!sameOrigin(event))
      return json(403, { error: "Request origin not allowed" });
    const body = parseBody(event);
    if (!body) return json(400, { error: "Expected valid JSON" });
    // Never accept another account as a target, including from an admin.
    if (
      body.email !== undefined &&
      String(body.email).trim().toLowerCase() !== email.toLowerCase()
    )
      return json(403, { error: "You can only manage your own holidays." });
    if (body.remove) {
      if (!/^[a-f0-9]{24}$/.test(String(body.remove)))
        return json(400, { error: "Invalid holiday record" });
      if (
        !approvedLeave(member.ops_streak_leave).some(
          (range) => range.id === body.remove,
        )
      )
        return json(404, { error: "Holiday not found" });
      await collection.updateOne(
        { email },
        { $pull: { ops_streak_leave: { id: body.remove } } },
      );
    } else {
      if (
        !validLeaveDay(body.start) ||
        !validLeaveDay(body.end) ||
        body.end < body.start ||
        Date.parse(body.end) - Date.parse(body.start) > 366 * 86400000
      )
        return json(400, {
          error:
            "Choose valid start and end dates, no more than one year apart.",
        });
      await collection.updateOne(
        { email },
        {
          $push: {
            ops_streak_leave: {
              id: randomBytes(12).toString("hex"),
              start: body.start,
              end: body.end,
              created_by: email,
            },
          },
        },
      );
    }
    member = await collection.findOne({ email });
  }
  return json(200, {
    leave: approvedLeave(member.ops_streak_leave).map(({ id, start, end }) => ({
      id,
      start,
      end,
    })),
    loginStreak: loginStreak(
      member.ops_login_days,
      undefined,
      member.ops_streak_leave,
    ),
    activityStreak: activityStreak(
      member.ops_activity_days,
      member.ops_streak_leave,
    ),
  });
}
function approvedLeave(ranges) {
  return (Array.isArray(ranges) ? ranges : []).filter(
    (range) =>
      range &&
      validLeaveDay(range.start) &&
      validLeaveDay(range.end) &&
      range.start <= range.end &&
      Date.parse(range.end) - Date.parse(range.start) <= 366 * 86400000,
  );
}
function validLeaveDay(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value + "T12:00:00Z")) &&
    new Date(value + "T12:00:00Z").toISOString().slice(0, 10) === value
  );
}
const {
  createHmac,
  timingSafeEqual,
  scrypt,
  randomBytes,
} = require("node:crypto");
const { promisify } = require("node:util");
const { MongoClient } = require("mongodb");

const scryptAsync = promisify(scrypt);
const COOKIE = "__Host-cg_session";
const SESSION_SECONDS = Number(process.env.AUTH_SESSION_SECONDS || 43200);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;
let client;

function json(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

async function users() {
  if (!client) {
    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
    client = new MongoClient(process.env.MONGODB_URI, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 7000,
    });
    await client.connect();
  }
  return client.db(process.env.MONGODB_DB || "connectgo").collection("users");
}

const encode = (value) => Buffer.from(value).toString("base64url");
const decode = (value) => Buffer.from(value, "base64url");

function signToken(claims) {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret || secret.length < 32)
    throw new Error("AUTH_JWT_SECRET must be at least 32 characters");
  const now = Math.floor(Date.now() / 1000);
  const header = encode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = encode(
    JSON.stringify({ ...claims, iat: now, exp: now + SESSION_SECONDS }),
  );
  const signature = encode(
    createHmac("sha256", secret).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${signature}`;
}

function verifyToken(token) {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret || !token) return null;
  const [header, payload, signature] = String(token).split(".");
  if (!header || !payload || !signature) return null;
  try {
    if (JSON.parse(decode(header).toString()).alg !== "HS256") return null;
    const expected = createHmac("sha256", secret)
      .update(`${header}.${payload}`)
      .digest();
    const actual = decode(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      return null;
    const claims = JSON.parse(decode(payload).toString());
    return typeof claims.exp === "number" &&
      claims.exp >= Math.floor(Date.now() / 1000)
      ? claims
      : null;
  } catch {
    return null;
  }
}

function getCookie(event) {
  const raw = event.headers?.cookie || event.headers?.Cookie || "";
  for (const pair of raw.split(";")) {
    const index = pair.indexOf("=");
    if (index > -1 && pair.slice(0, index).trim() === COOKIE)
      return pair.slice(index + 1).trim();
  }
  return "";
}

function setCookie(token, maxAge) {
  return [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

function checkPassword(password, stored) {
  if (typeof stored !== "string") return Promise.resolve(false);
  const [scheme, N, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt") return Promise.resolve(false);
  const expected = Buffer.from(hash, "base64");
  return scryptAsync(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  })
    .then((value) => {
      const actual = Buffer.from(value);
      return (
        actual.length === expected.length && timingSafeEqual(actual, expected)
      );
    })
    .catch(() => false);
}

function isLockedOut(user) {
  return Boolean(
    user &&
      (user.failed_attempts || 0) >= MAX_ATTEMPTS &&
      Date.now() - new Date(user.last_failed_at || 0).getTime() < LOCKOUT_MS,
  );
}

const DUMMY_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

async function validPassword(user, password) {
  const matches = await checkPassword(
    password,
    user?.password_hash || DUMMY_HASH,
  );
  return matches && Boolean(user) && user.active !== false;
}

async function recordLogin(collection, email, user, valid) {
  try {
    if (valid)
      await collection.updateOne(
        { email },
        { $set: { failed_attempts: 0, last_login_at: new Date() } },
      );
    else if (user)
      await collection.updateOne(
        { email },
        { $inc: { failed_attempts: 1 }, $set: { last_failed_at: new Date() } },
      );
  } catch (error) {
    console.error("Could not save sign-in attempt:", error.message);
  }
}

// Operations login streak: successful sign-ins, counted once per Zurich day.
const LOGIN_ZONE = "Europe/Zurich";

function loginDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LOGIN_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function weekday(key) {
  const day = new Date(`${key}T12:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function previousWorkday(key) {
  const date = new Date(`${key}T12:00:00Z`);
  do {
    date.setUTCDate(date.getUTCDate() - 1);
  } while (!weekday(date.toISOString().slice(0, 10)));
  return date.toISOString().slice(0, 10);
}

function loginStreak(days, today = loginDay(), leave = []) {
  const ranges = approvedLeave(leave);
  const paused = (key) =>
    ranges.some((range) => key >= range.start && key <= range.end);
  const eligible = (key) => weekday(key) && !paused(key);
  const previousEligible = (key) => {
    const date = new Date(key + "T12:00:00Z");
    do {
      date.setUTCDate(date.getUTCDate() - 1);
      key = date.toISOString().slice(0, 10);
    } while (!eligible(key));
    return key;
  };
  const all = [
    ...new Set(
      (Array.isArray(days) ? days : []).filter(
        (key) => validLeaveDay(key) && key <= today,
      ),
    ),
  ].sort();
  const dates = all.filter(eligible),
    recorded = new Set(dates);
  let best = 0,
    run = 0,
    previous = null;
  for (const key of dates) {
    run = previous === previousEligible(key) ? run + 1 : 1;
    best = Math.max(best, run);
    previous = key;
  }
  let anchor = eligible(today) ? today : previousEligible(today),
    current = 0,
    startDate = null;
  if (!recorded.has(anchor) && eligible(today))
    anchor = previousEligible(anchor);
  while (recorded.has(anchor)) {
    current++;
    startDate = anchor;
    anchor = previousEligible(anchor);
  }
  const monday = new Date(today + "T12:00:00Z");
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const week = Array.from({ length: 5 }, (_, i) => {
    const day = new Date(monday);
    day.setUTCDate(day.getUTCDate() + i);
    const date = day.toISOString().slice(0, 10);
    return { date, loggedIn: recorded.has(date), paused: paused(date) };
  });
  const recent = [];
  let cursor = weekday(today) ? today : previousWorkday(today);
  for (let i = 0; i < 5; i++) {
    recent.unshift({
      date: cursor,
      loggedIn: recorded.has(cursor),
      paused: paused(cursor),
    });
    cursor = previousWorkday(cursor);
  }
  const currentLeave = ranges
    .filter((range) => today >= range.start && today <= range.end)
    .sort((a, b) => b.end.localeCompare(a.end))[0];
  return {
    current,
    startDate,
    best,
    week,
    recent,
    timeZone: LOGIN_ZONE,
    weekendsPaused: true,
    leavePaused: !!currentLeave,
    pauseUntil: currentLeave?.end || null,
  };
}

async function recordLoginDay(collection, email) {
  const day = loginDay();
  try {
    await collection.updateOne(
      { email },
      { $addToSet: { ops_login_days: day } },
    );
  } catch (error) {
    console.error("Could not record Operations login day:", error.message);
  }
}

async function recordActivityDay(email) {
  try {
    await (
      await users()
    ).updateOne({ email }, { $addToSet: { ops_activity_days: loginDay() } });
    return true;
  } catch (error) {
    console.error("Could not record Operations activity:", error.message);
    return false;
  }
}

function activityStreak(days, leave = []) {
  const source = Array.isArray(days) ? days : [],
    today = loginDay(),
    streak = loginStreak(source, today, leave);
  return {
    activeToday: source.includes(today),
    continuing: streak.current > 0,
    leavePaused: streak.leavePaused,
    pauseUntil: streak.pauseUntil,
    recent: streak.recent.map((day) => ({
      date: day.date,
      active: day.loggedIn,
      paused: day.paused,
    })),
  };
}

function parseBody(event) {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch {
    return null;
  }
}

function hasDashboardRole(session, requiredRole = process.env.SITE_KEY) {
  const roles = (session?.roles || []).map((role) =>
    String(role).toLowerCase(),
  );
  return (
    !requiredRole || roles.includes("admin") || roles.includes(requiredRole)
  );
}

// Checks the cookie AND the live user record, so deactivating someone or
// removing a role takes effect on their next request, not when their session
// expires. Pass '' as requiredRole for "any signed-in user". Fails closed if
// the database can't be reached.
async function requireUser(event, requiredRole = process.env.SITE_KEY) {
  const session = verifyToken(getCookie(event));
  if (!session?.email) return null;
  let user;
  try {
    user = await (
      await users()
    ).findOne({ email: session.email }, { projection: { password_hash: 0 } });
  } catch (error) {
    console.error("Could not check session against users:", error.message);
    return null;
  }
  if (!user || user.active === false) return null;
  const current = {
    ...session,
    name: user.name || null,
    roles: user.roles || [],
    loginStreak: loginStreak(
      user.ops_login_days,
      undefined,
      user.ops_streak_leave,
    ),
    activityStreak: activityStreak(
      user.ops_activity_days,
      user.ops_streak_leave,
    ),
  };
  return hasDashboardRole(current, requiredRole) ? current : null;
}

function unauthorized() {
  return json(401, { error: "Not authorised" });
}

// State-changing requests must come from this site's own pages. SameSite=Lax
// already keeps the cookie off cross-site POSTs; this is belt and braces.
function sameOrigin(event) {
  const origin = event.headers?.origin;
  const host = event.headers?.["x-forwarded-host"] || event.headers?.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64"),
    Buffer.from(hash).toString("base64"),
  ].join("$");
}

const MIN_PASSWORD = 12;

async function changePassword(event) {
  if (!sameOrigin(event))
    return json(403, { error: "Cross-site request refused" });
  const session = await requireUser(event, "");
  if (!session) return unauthorized();
  const body = parseBody(event);
  if (!body) return json(400, { error: "Expected valid JSON" });
  const current = String(body.current || "");
  const next = String(body.next || "");
  if (next.length < MIN_PASSWORD)
    return json(400, {
      error: `New password must be at least ${MIN_PASSWORD} characters`,
    });
  if (next === current)
    return json(400, {
      error: "New password must be different from the current one",
    });

  const collection = await users();
  const user = await collection.findOne({ email: session.email });
  if (isLockedOut(user))
    return json(429, {
      error: "Too many failed attempts. Try again in 15 minutes.",
    });
  const valid = await validPassword(user, current);
  await recordLogin(collection, session.email, user, valid);
  if (!valid) return json(401, { error: "Current password is incorrect" });

  await collection.updateOne(
    { email: session.email },
    {
      $set: {
        password_hash: await hashPassword(next),
        password_changed_at: new Date(),
        updated_at: new Date(),
      },
    },
  );
  return json(200, { ok: true });
}

exports.loginStreak = loginStreak;
exports.activityStreak = activityStreak;
exports.recordActivityDay = recordActivityDay;
exports.requireUser = requireUser;
exports.unauthorized = unauthorized;
exports.sameOrigin = sameOrigin;
exports.hashPassword = hashPassword;
exports.isLockedOut = isLockedOut;
exports.parseBody = parseBody;
exports.users = users;
exports.json = json;

exports.handler = async (event) => {
  const action = event.queryStringParameters?.action;

  if (action === "streak-leave") {
    try {
      return await manageStreakLeave(event);
    } catch (error) {
      console.error("Holiday settings unavailable:", error.message);
      return json(503, {
        error: "Holiday settings are temporarily unavailable",
      });
    }
  }
  if (action === "logout") {
    return {
      statusCode: 302,
      headers: {
        location: "/login.html?signed_out=1",
        "cache-control": "no-store",
        "set-cookie": setCookie("", 0),
      },
      body: "",
    };
  }

  if (action === "me" && event.httpMethod === "GET") {
    const session = await requireUser(event, "");
    if (!session) return unauthorized();
    return json(200, {
      email: session.email,
      name: session.name,
      roles: session.roles,
      loginStreak: session.loginStreak,
      activityStreak: session.activityStreak,
      site: process.env.SITE_KEY || null,
    });
  }

  if (action === "change-password" && event.httpMethod === "POST") {
    try {
      return await changePassword(event);
    } catch (error) {
      console.error("Password change unavailable:", error.message);
      return json(503, { error: "Password change is temporarily unavailable" });
    }
  }

  if (action !== "login" || event.httpMethod !== "POST")
    return json(405, { error: "Method not allowed" });
  const body = parseBody(event);
  if (!body) return json(400, { error: "Expected valid JSON" });

  const email = String(body.email || "")
    .trim()
    .toLowerCase();
  const password = String(body.password || "");
  if (!email || !password)
    return json(400, { error: "Email and password are required" });

  try {
    const collection = await users();
    const user = await collection.findOne({ email });
    if (isLockedOut(user))
      return json(429, {
        error: "Too many failed attempts. Try again in 15 minutes.",
      });
    const valid = await validPassword(user, password);
    await recordLogin(collection, email, user, valid);
    if (!valid) return json(401, { error: "Incorrect email or password" });

    const token = signToken({
      sub: String(user._id),
      email: user.email,
      name: user.name || null,
      roles: user.roles || [],
    });
    if (
      (process.env.SITE_KEY || "ops").toLowerCase() === "ops" &&
      hasDashboardRole(user, "ops")
    ) {
      await recordLoginDay(collection, email);
    }
    return json(
      200,
      { ok: true },
      { "set-cookie": setCookie(token, SESSION_SECONDS) },
    );
  } catch (error) {
    console.error("Sign-in unavailable:", error.message);
    return json(503, { error: "Sign-in is temporarily unavailable" });
  }
};
