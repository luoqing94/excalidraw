import React, { useEffect, useState, useRef, useCallback } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { api } from "./api.js";

function fmtTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// Strip runtime-only fields before persisting
function sanitizeAppState(appState = {}) {
  const {
    collaborators,
    currentChartType,
    exportBackground,
    gridSize,
    name,
    theme,
    viewBackgroundColor,
    zenModeEnabled,
    zoom,
    scrollX,
    scrollY,
  } = appState;
  return {
    currentChartType,
    exportBackground,
    gridSize,
    name,
    theme,
    viewBackgroundColor,
    zenModeEnabled,
    zoom,
    scrollX,
    scrollY,
  };
}

export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginErr, setLoginErr] = useState("");

  const [docs, setDocs] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [currentTitle, setCurrentTitle] = useState("");
  const [initialScene, setInitialScene] = useState(null); // { key, elements, appState, files }
  const [status, setStatus] = useState("未打开画布");
  const [saving, setSaving] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [toast, setToast] = useState(null); // { text, kind }

  const toastTimerRef = useRef(null);
  const showToast = useCallback((text, kind = "ok", ms = 1800) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ text, kind });
    toastTimerRef.current = setTimeout(() => setToast(null), ms);
  }, []);

  const excalidrawAPIRef = useRef(null);
  const sceneCacheRef = useRef({ elements: [], appState: {}, files: {} });
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef(null);
  const currentIdRef = useRef(null);
  const currentTitleRef = useRef("");
  const skipDirtyUntilRef = useRef(0);

  useEffect(() => {
    currentIdRef.current = currentId;
  }, [currentId]);

  useEffect(() => {
    currentTitleRef.current = currentTitle;
  }, [currentTitle]);

  const refreshDocs = useCallback(async () => {
    const { docs: list } = await api.listDocs();
    setDocs(list || []);
    return list || [];
  }, []);

  const flushSave = useCallback(async (reason = "自动保存", { notify = false } = {}) => {
    const id = currentIdRef.current;
    if (!id) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setSaving(true);
    setStatus("正在保存到云端…");
    try {
      const { elements, appState, files } = sceneCacheRef.current;
      const res = await api.saveDoc(id, {
        title: currentTitleRef.current || "未命名画布",
        elements,
        appState: sanitizeAppState(appState),
        files,
      });
      dirtyRef.current = false;
      setStatus(`已保存 (${reason}) · ${fmtTime(res.updatedAt)}`);
      setDocs((prev) => {
        const next = prev.map((d) =>
          d.id === id ? { ...d, title: res.title, updatedAt: res.updatedAt } : d,
        );
        next.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
        return next;
      });
      if (notify) showToast("已保存到云端");
    } catch (e) {
      setStatus(`保存失败：${e.message}`);
      if (notify) showToast(`保存失败：${e.message}`, "err", 2800);
      if (e.status === 401) setAuthed(false);
    } finally {
      setSaving(false);
    }
  }, [showToast]);

  const applyLoadedDoc = useCallback((doc) => {
    if (!doc || !doc.id) return;
    const id = doc.id;
    skipDirtyUntilRef.current = Date.now() + 900;
    currentIdRef.current = id;
    setCurrentId(id);
    setCurrentTitle(doc.title || "未命名画布");
    const safeAppState = sanitizeAppState(doc.appState || {});
    sceneCacheRef.current = {
      elements: doc.elements || [],
      appState: safeAppState,
      files: doc.files || {},
    };
    dirtyRef.current = false;
    setInitialScene({
      key: `${id}:${doc.updatedAt || Date.now()}`,
      elements: doc.elements || [],
      appState: { ...safeAppState, collaborators: new Map() },
      files: doc.files || {},
    });
    setStatus(`已加载 · ${fmtTime(doc.updatedAt)}`);
    setSidebarOpen(false);
  }, []);

  const openDoc = useCallback(async (id, { flushPrev = true } = {}) => {
    if (!id) return;
    if (flushPrev && dirtyRef.current && currentIdRef.current) {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      await flushSave("切换前已保存");
    }
    setStatus("加载中…");
    try {
      const { doc } = await api.getDoc(id);
      applyLoadedDoc(doc);
    } catch (e) {
      setStatus(`加载失败：${e.message}`);
    }
  }, [flushSave, applyLoadedDoc]);

  const hydrateBootstrap = useCallback(async (res) => {
    if (Array.isArray(res?.docs)) {
      setDocs(res.docs);
      if (res.initialDoc && res.initialDoc.id) {
        applyLoadedDoc(res.initialDoc);
        return;
      }
      if (res.docs.length > 0) {
        await openDoc(res.docs[0].id, { flushPrev: false });
      } else {
        const { doc } = await api.createDoc("默认画布");
        await refreshDocs();
        applyLoadedDoc(doc);
      }
      return;
    }
    const list = await refreshDocs();
    if (list.length > 0) {
      await openDoc(list[0].id, { flushPrev: false });
    } else {
      const { doc } = await api.createDoc("默认画布");
      await refreshDocs();
      await openDoc(doc.id, { flushPrev: false });
    }
  }, [applyLoadedDoc, openDoc, refreshDocs]);

  // Initial auth check + 1-RTT bootstrap
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.me();
        if (cancelled) return;
        setAuthed(true);
        await hydrateBootstrap(res);
      } catch {
        if (!cancelled) setAuthed(false);
      } finally {
        if (!cancelled) setAuthChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrateBootstrap]);

  // Ctrl+S / Cmd+S manual save
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        flushSave("手动保存", { notify: true });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flushSave]);

  const scheduleAutoSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      if (dirtyRef.current) flushSave("自动保存");
    }, 1800);
  }, [flushSave]);

  const onSceneChange = useCallback(
    (elements, appState, files) => {
      sceneCacheRef.current = { elements, appState, files };
      if (!currentIdRef.current) return;
      if (Date.now() < skipDirtyUntilRef.current) return;
      dirtyRef.current = true;
      setStatus("有未保存更改…");
      scheduleAutoSave();
    },
    [scheduleAutoSave],
  );

  const onTitleChange = (e) => {
    const v = e.target.value;
    setCurrentTitle(v);
    if (!currentIdRef.current) return;
    dirtyRef.current = true;
    setStatus("标题待保存…");
    scheduleAutoSave();
  };

  const onNewDoc = async () => {
    const name = window.prompt("新画布名称：", `画布 ${docs.length + 1}`);
    if (name === null) return;
    if (dirtyRef.current && currentIdRef.current) {
      await flushSave("新建前已保存");
    }
    try {
      const { doc } = await api.createDoc(name.trim() || "未命名画布");
      await refreshDocs();
      applyLoadedDoc(doc);
    } catch (e) {
      alert(`新建失败：${e.message}`);
    }
  };

  const onDeleteDoc = async () => {
    if (!currentId) return;
    if (!window.confirm(`确定删除画布「${currentTitle || "未命名"}」吗？此操作不可撤销。`)) return;
    try {
      await api.deleteDoc(currentId);
      const list = await refreshDocs();
      if (list.length > 0) {
        await openDoc(list[0].id, { flushPrev: false });
      } else {
        setCurrentId(null);
        setInitialScene(null);
        setStatus("已删除，暂无画布");
      }
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  };

  const onLogout = async () => {
    if (dirtyRef.current && currentIdRef.current) {
      await flushSave("退出前已保存");
    }
    await api.logout().catch(() => {});
    setAuthed(false);
    setCurrentId(null);
    setInitialScene(null);
  };

  const onLogin = async (e) => {
    e.preventDefault();
    setLoginBusy(true);
    setLoginErr("");
    try {
      const res = await api.login(password);
      setPassword("");
      setAuthed(true);
      await hydrateBootstrap(res);
    } catch (err) {
      setLoginErr(err.message || "登录失败");
    } finally {
      setLoginBusy(false);
    }
  };

  if (!authChecked) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <h1>Excalidraw Sync</h1>
          <div className="sub">正在检查登录状态…</div>
        </div>
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="login-wrap">
        <form className="login-card" onSubmit={onLogin}>
          <h1>✏️ Excalidraw 云画布</h1>
          <div className="sub">请输入访问密码解锁你的多文档云端画布</div>
          <input
            type="password"
            placeholder="访问密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            required
          />
          <div className="err">{loginErr}</div>
          <button type="submit" disabled={loginBusy}>
            {loginBusy ? "正在验证…" : "进入画布"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className={`app ${currentId ? "has-doc" : "no-doc"} ${sidebarOpen ? "sidebar-open" : "sidebar-collapsed"}`}>
      {currentId && sidebarOpen && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="关闭侧栏"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={`sidebar ${sidebarOpen ? "is-open" : "is-closed"}`}>
        <div className="sidebar-head">
          <h2>✏️ 我的画布</h2>
          {currentId && (
            <button
              className="btn secondary"
              style={{ padding: "6px 10px", fontSize: "0.78rem" }}
              onClick={() => setSidebarOpen(false)}
              title="收起菜单"
            >
              收起
            </button>
          )}
          <button
            className="btn secondary"
            style={{ padding: "6px 10px", fontSize: "0.78rem" }}
            onClick={onLogout}
            title="退出登录"
          >
            退出
          </button>
        </div>
        {currentId && (
          <div className="panel-doc-meta">
            <input
              className="title-input"
              value={currentTitle}
              onChange={onTitleChange}
              placeholder="画布标题"
            />
            <button
              className="btn"
              onClick={() => flushSave("手动保存", { notify: true })}
              disabled={saving}
            >
              {saving ? "保存中…" : "💾 保存到云端"}
            </button>
          </div>
        )}
        <div className="sidebar-actions">
          <button className="btn" onClick={onNewDoc}>
            ＋ 新建画布
          </button>
          <button className="btn danger" onClick={onDeleteDoc} disabled={!currentId}>
            删除
          </button>
        </div>
        <div className="doc-list">
          {docs.map((d) => (
            <button
              key={d.id}
              type="button"
              className={`doc-item ${d.id === currentId ? "active" : ""}`}
              onClick={() => openDoc(d.id)}
            >
              <div className="title">{d.title || "未命名画布"}</div>
              <div className="meta">更新于 {fmtTime(d.updatedAt)}</div>
            </button>
          ))}
        </div>
      </aside>

      <main className="main">
        {currentId && (
          <button
            type="button"
            className="fab-menu"
            onClick={() => setSidebarOpen((v) => !v)}
            title="画布菜单（切换 / 新建 / 保存）"
            aria-label="画布菜单"
          >
            ⋯
          </button>
        )}
        {toast && (
          <div className={`toast toast-${toast.kind}`}>
            {toast.text}
          </div>
        )}

        <div className="canvas">
          {initialScene ? (
            <Excalidraw
              key={initialScene.key}
              excalidrawAPI={(apiInstance) => {
                excalidrawAPIRef.current = apiInstance;
              }}
              initialData={{
                elements: initialScene.elements,
                appState: initialScene.appState,
                files: initialScene.files,
              }}
              onChange={onSceneChange}
              langCode="zh-CN"
            />
          ) : (
            <div className="empty">请从左侧选择或新建一个画布</div>
          )}
        </div>
      </main>
    </div>
  );
}
