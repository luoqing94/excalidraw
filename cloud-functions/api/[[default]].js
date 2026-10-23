import { getStore } from "@edgeone/pages-blob";

const STORE_NAME = "excalidraw-docs";
const INDEX_KEY = "_index.json";
const COOKIE_NAME = "ex_sync_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30 days
const MAX_BODY_BYTES = 15 * 1024 * 1024; // 15 MB

const enc = new TextEncoder();

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function makeToken(secret) {
  const exp = Date.now() + SESSION_TTL_SEC * 1000;
  const payload = `owner.${exp}`;
  const sig = await hmacHex(secret, payload);
  return `${payload}.${sig}`;
}

async function verifyToken(token, secret) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [sub, expStr, sig] = parts;
  if (sub !== "owner") return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;
  const expected = await hmacHex(secret, `${sub}.${expStr}`);
  if (!safeEqual(sig, expected)) return null;
  return { sub, exp };
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function makeCookieHeader(value, maxAge = SESSION_TTL_SEC) {
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function requireAuth(context) {
  const secret = context.env?.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET not configured");
  const cookies = parseCookies(context.request.headers.get("cookie"));
  const v = await verifyToken(cookies[COOKIE_NAME], secret);
  if (v) return v;
  const sharePwd = context.request.headers.get("x-share-password");
  const expectedHash = (context.env?.AUTH_PASSWORD_HASH || "").trim().toLowerCase();
  if (sharePwd && expectedHash) {
    const gotHash = await sha256Hex(String(sharePwd));
    if (safeEqual(gotHash, expectedHash)) {
      return { sub: "owner", exp: Date.now() + SESSION_TTL_SEC * 1000 };
    }
  }
  return null;
}

function store() {
  return getStore({ name: STORE_NAME });
}

async function getJson(key, fallback) {
  const s = store();
  try {
    const raw = await s.get(key, { type: "text" });
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function putJson(key, val) {
  const s = store();
  await s.set(key, JSON.stringify(val));
}

async function readIndex() {
  const idx = await getJson(INDEX_KEY, { docs: [] });
  if (!idx || !Array.isArray(idx.docs)) return { docs: [] };
  return idx;
}

function docKey(id) {
  return `docs/${id}.json`;
}

async function getBootstrapPayload() {
  const idx = await readIndex();
  const docs = [...idx.docs].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  let initialDoc = null;
  if (docs.length > 0 && docs[0]?.id) {
    initialDoc = await getJson(docKey(docs[0].id), null);
  }
  return { docs, initialDoc };
}

function validId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{4,64}$/.test(id);
}

function genId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readBodyJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("Payload too large");
  return text ? JSON.parse(text) : {};
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const sub = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  const method = request.method.toUpperCase();

  try {
    // POST /api/login
    if (sub === "login" && method === "POST") {
      const body = await readBodyJson(request);
      const pwd = String(body.password || "");
      const expectedHash = (env?.AUTH_PASSWORD_HASH || "").trim().toLowerCase();
      const secret = env?.SESSION_SECRET;
      if (!expectedHash || !secret) {
        return err("Server auth env not configured", 500);
      }
      const gotHash = await sha256Hex(pwd);
      if (!safeEqual(gotHash, expectedHash)) {
        await new Promise((r) => setTimeout(r, 350));
        return err("密码错误", 401);
      }
      const token = await makeToken(secret);
      const bootstrap = await getBootstrapPayload();
      return json({ ok: true, user: "owner", ...bootstrap }, 200, {
        "set-cookie": makeCookieHeader(token),
      });
    }

    // POST /api/logout
    if (sub === "logout" && method === "POST") {
      return json({ ok: true }, 200, {
        "set-cookie": makeCookieHeader("", 0),
      });
    }

    // GET /api or GET /api/me (Single-RTT auth check + initial bootstrap)
    if ((sub === "me" || sub === "") && method === "GET") {
      const u = await requireAuth(context);
      if (!u) return json({ authed: false, error: "未登录或会话已过期" }, 401);
      const bootstrap = await getBootstrapPayload();
      return json({ ok: true, authed: true, user: "owner", ...bootstrap });
    }

    // POST /api (Legacy verify/save compatibility)
    if (sub === "" && method === "POST") {
      const body = await readBodyJson(request);
      if (body.action === "verify" || body.password) {
        const pwd = String(body.password || request.headers.get("x-share-password") || "");
        const expectedHash = (env?.AUTH_PASSWORD_HASH || "").trim().toLowerCase();
        const gotHash = await sha256Hex(pwd);
        if (!expectedHash || !safeEqual(gotHash, expectedHash)) {
          return err("密码错误", 401);
        }
        const bootstrap = await getBootstrapPayload();
        return json({ ok: true, user: "owner", ...bootstrap });
      }
    }

    // All routes below require auth
    const user = await requireAuth(context);
    if (!user) return err("未登录或会话已过期", 401);

    // GET /api/docs
    if (sub === "docs" && method === "GET") {
      const idx = await readIndex();
      const sorted = [...idx.docs].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
      return json({ docs: sorted });
    }

    // POST /api/docs (create new doc)
    if (sub === "docs" && method === "POST") {
      const body = await readBodyJson(request);
      const title = String(body.title || "未命名画布").slice(0, 120);
      const id = genId();
      const now = new Date().toISOString();
      const doc = {
        id,
        title,
        createdAt: now,
        updatedAt: now,
        elements: Array.isArray(body.elements) ? body.elements : [],
        appState: body.appState && typeof body.appState === "object" ? body.appState : {},
        files: body.files && typeof body.files === "object" ? body.files : {},
      };
      await putJson(docKey(id), doc);
      const idx = await readIndex();
      idx.docs.unshift({ id, title, createdAt: now, updatedAt: now });
      await putJson(INDEX_KEY, idx);
      return json({ doc }, 201);
    }

    // /api/docs/:id
    const m = sub.match(/^docs\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (!validId(id)) return err("Invalid doc id", 400);

      if (method === "GET") {
        const doc = await getJson(docKey(id), null);
        if (!doc) return err("画布不存在", 404);
        return json({ doc });
      }

      if (method === "PUT" || method === "PATCH") {
        const body = await readBodyJson(request);
        const existing = (await getJson(docKey(id), null)) || {
          id,
          title: "未命名画布",
          createdAt: new Date().toISOString(),
          elements: [],
          appState: {},
          files: {},
        };
        const now = new Date().toISOString();
        const updated = {
          ...existing,
          id,
          title: body.title !== undefined ? String(body.title).slice(0, 120) : existing.title,
          elements: Array.isArray(body.elements) ? body.elements : existing.elements,
          appState: body.appState && typeof body.appState === "object" ? body.appState : existing.appState,
          files: body.files && typeof body.files === "object" ? body.files : existing.files,
          updatedAt: now,
        };
        await putJson(docKey(id), updated);

        const idx = await readIndex();
        const entry = idx.docs.find((d) => d.id === id);
        if (entry) {
          entry.title = updated.title;
          entry.updatedAt = now;
        } else {
          idx.docs.unshift({ id, title: updated.title, createdAt: updated.createdAt, updatedAt: now });
        }
        await putJson(INDEX_KEY, idx);
        return json({ ok: true, updatedAt: now, title: updated.title });
      }

      if (method === "DELETE") {
        const s = store();
        await s.delete(docKey(id));
        const idx = await readIndex();
        idx.docs = idx.docs.filter((d) => d.id !== id);
        await putJson(INDEX_KEY, idx);
        return json({ ok: true });
      }
    }

    return err(`Not found: ${method} /api/${sub}`, 404);
  } catch (e) {
    return err(e?.message || "Internal error", 500);
  }
}
