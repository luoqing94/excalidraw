import { getStore } from "@edgeone/pages-blob";
import { createHash, createHmac, timingSafeEqual, randomBytes } from "crypto";

const STORE_NAME = "excalidraw-docs";
const INDEX_KEY = "_index.json";
const COOKIE_NAME = "ex_sync_session";
const SESSION_TTL_SEC = 30 * 24 * 3600;

const store = getStore({ name: STORE_NAME, consistency: "strong" });

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function getHeader(headers, name) {
  if (!headers) return "";
  const lower = name.toLowerCase();
  if (typeof headers.get === "function") return headers.get(name) || headers.get(lower) || "";
  return headers[name] || headers[lower] || headers[name.toLowerCase()] || "";
}

function getCookie(request, name) {
  const raw = getHeader(request.headers, "cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function setCookie(name, value, maxAge) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

function clearCookie(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function sha256Hex(s) {
  return createHash("sha256").update(String(s), "utf8").digest("hex");
}

function safeEqualHex(a, b) {
  try {
    const ba = Buffer.from(String(a), "utf8");
    const bb = Buffer.from(String(b), "utf8");
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64url(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

function signPayload(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function makeToken(data, secret, ttlSec) {
  const body = { ...data, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const payload = b64url(Buffer.from(JSON.stringify(body), "utf8"));
  const sig = signPayload(payload, secret);
  return `${payload}.${sig}`;
}

function readToken(token, secret) {
  if (!token || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expect = signPayload(payload, secret);
  const a = Buffer.from(String(sig), "utf8");
  const b = Buffer.from(String(expect), "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const body = JSON.parse(fromB64url(payload).toString("utf8"));
    if (!body.exp || body.exp < Math.floor(Date.now() / 1000)) return null;
    if (body.v !== 1) return null;
    return body;
  } catch {
    return null;
  }
}

function getEnv(context) {
  return context?.env || {};
}

function requireAuth(context) {
  const env = getEnv(context);
  const secret = env.SESSION_SECRET;
  if (!secret) return { ok: false, status: 500, error: "SESSION_SECRET not configured" };
  const token = getCookie(context.request, COOKIE_NAME);
  const session = readToken(token, secret);
  if (!session) return { ok: false, status: 401, error: "unauthorized" };
  return { ok: true, session };
}

async function readIndex() {
  const data = await store.get(INDEX_KEY, { type: "json", consistency: "strong" });
  if (!data || !Array.isArray(data.docs)) return { docs: [] };
  return data;
}

async function writeIndex(index) {
  await store.setJSON(INDEX_KEY, index);
}

function newId() {
  return randomBytes(8).toString("hex");
}

async function parseBody(request) {
  if (request.body && typeof request.body === "object" && !request.body.getReader) {
    return request.body;
  }
  try {
    if (typeof request.json === "function") return await request.json();
  } catch {
    /* ignore */
  }
  try {
    const text = typeof request.text === "function" ? await request.text() : "";
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function apiPath(pathname) {
  return pathname.replace(/^\/api/, "") || "/";
}

export default async function onRequest(context) {
  const request = context.request;
  const url = new URL(request.url);
  const method = (request.method || "GET").toUpperCase();
  const path = apiPath(url.pathname);

  // CORS preflight (same-origin mostly, but safe)
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Credentials": "true",
      },
    });
  }

  try {
    // POST /api/login
    if (path === "/login" && method === "POST") {
      const env = getEnv(context);
      const expectedHash = env.AUTH_PASSWORD_HASH;
      const secret = env.SESSION_SECRET;
      if (!expectedHash || !secret) {
        return json({ error: "auth not configured" }, 500);
      }
      const body = await parseBody(request);
      const password = body?.password ?? "";
      const got = sha256Hex(password);
      if (!safeEqualHex(got, expectedHash)) {
        return json({ error: "invalid password" }, 401);
      }
      const token = makeToken({ v: 1, sub: "owner" }, secret, SESSION_TTL_SEC);
      return json(
        { ok: true },
        200,
        { "Set-Cookie": setCookie(COOKIE_NAME, token, SESSION_TTL_SEC) },
      );
    }

    // POST /api/logout
    if (path === "/logout" && method === "POST") {
      return json({ ok: true }, 200, { "Set-Cookie": clearCookie(COOKIE_NAME) });
    }

    // GET /api/me
    if (path === "/me" && method === "GET") {
      const auth = requireAuth(context);
      if (!auth.ok) return json({ ok: false }, auth.status);
      return json({ ok: true, user: "owner" });
    }

    // All doc routes need auth
    const auth = requireAuth(context);
    if (!auth.ok) return json({ error: auth.error }, auth.status);

    // GET /api/docs
    if (path === "/docs" && method === "GET") {
      const index = await readIndex();
      const docs = [...index.docs].sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
      return json({ docs });
    }

    // POST /api/docs  create
    if (path === "/docs" && method === "POST") {
      const body = await parseBody(request);
      const title = String(body?.title || "未命名画布").slice(0, 120);
      const id = newId();
      const now = new Date().toISOString();
      const doc = {
        id,
        title,
        createdAt: now,
        updatedAt: now,
        elements: [],
        appState: { viewBackgroundColor: "#ffffff" },
        files: {},
      };
      await store.setJSON(`docs/${id}.json`, doc);
      const index = await readIndex();
      index.docs.push({ id, title, createdAt: now, updatedAt: now });
      await writeIndex(index);
      return json({ doc }, 201);
    }

    const docMatch = path.match(/^\/docs\/([a-f0-9]+)$/i);
    if (docMatch) {
      const id = docMatch[1];

      // GET
      if (method === "GET") {
        const doc = await store.get(`docs/${id}.json`, { type: "json", consistency: "strong" });
        if (!doc) return json({ error: "not found" }, 404);
        return json({ doc });
      }

      // PUT save scene
      if (method === "PUT") {
        const body = await parseBody(request);
        const existing = await store.get(`docs/${id}.json`, { type: "json", consistency: "strong" });
        if (!existing) return json({ error: "not found" }, 404);
        const now = new Date().toISOString();
        const title = body?.title != null ? String(body.title).slice(0, 120) : existing.title;
        const doc = {
          ...existing,
          title,
          updatedAt: now,
          elements: body?.elements ?? existing.elements ?? [],
          appState: body?.appState ?? existing.appState ?? {},
          files: body?.files ?? existing.files ?? {},
        };
        // Strip volatile UI state noise if present
        if (doc.appState && typeof doc.appState === "object") {
          const { collaborators, ...rest } = doc.appState;
          doc.appState = rest;
        }
        await store.setJSON(`docs/${id}.json`, doc);
        const index = await readIndex();
        const meta = index.docs.find((d) => d.id === id);
        if (meta) {
          meta.title = title;
          meta.updatedAt = now;
        } else {
          index.docs.push({ id, title, createdAt: existing.createdAt || now, updatedAt: now });
        }
        await writeIndex(index);
        return json({ ok: true, updatedAt: now, title });
      }

      // PATCH rename
      if (method === "PATCH") {
        const body = await parseBody(request);
        const title = String(body?.title || "").trim().slice(0, 120);
        if (!title) return json({ error: "title required" }, 400);
        const existing = await store.get(`docs/${id}.json`, { type: "json", consistency: "strong" });
        if (!existing) return json({ error: "not found" }, 404);
        const now = new Date().toISOString();
        existing.title = title;
        existing.updatedAt = now;
        await store.setJSON(`docs/${id}.json`, existing);
        const index = await readIndex();
        const meta = index.docs.find((d) => d.id === id);
        if (meta) {
          meta.title = title;
          meta.updatedAt = now;
        }
        await writeIndex(index);
        return json({ ok: true, title, updatedAt: now });
      }

      // DELETE
      if (method === "DELETE") {
        await store.delete(`docs/${id}.json`);
        const index = await readIndex();
        index.docs = index.docs.filter((d) => d.id !== id);
        await writeIndex(index);
        return json({ ok: true });
      }
    }

    return json({ error: "Not Found", path, method }, 404);
  } catch (err) {
    return json({ error: "server_error", detail: String(err?.message || err) }, 500);
  }
}
