async function req(path, options = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  me: () => req("/api/me"),
  login: (password) => req("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => req("/api/logout", { method: "POST", body: "{}" }),
  listDocs: () => req("/api/docs"),
  createDoc: (title) => req("/api/docs", { method: "POST", body: JSON.stringify({ title }) }),
  getDoc: (id) => req(`/api/docs/${id}`),
  saveDoc: (id, payload) => req(`/api/docs/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  renameDoc: (id, title) => req(`/api/docs/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteDoc: (id) => req(`/api/docs/${id}`, { method: "DELETE" }),
};
