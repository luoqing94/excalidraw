import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { api } from "./api.js";

const SAVE_DEBOUNCE_MS = 1200;
const TOAST_MS = 2000;

function formatTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

/** Fingerprint of data we care about for dirty detection (ignore pointer/selection/zoom/scroll). */
function persistFingerprint(elements, files, appState) {
  return JSON.stringify({
    elements: elements || [],
    files: files || {},
    viewBackgroundColor: appState?.viewBackgroundColor ?? null,
    gridSize: appState?.gridSize ?? null,
  });
}

/** Strip volatile UI fields before PUT; keep viewport + drawing prefs for restore. */
function sanitizeAppState(appState) {
  if (!appState || typeof appState !== "object") return {};
  const {
    collaborators,
    selectedElementIds,
    selectedGroupIds,
    selectedLinearElement,
    editingElement,
    editingGroupId,
    editingLinearElement,
    isResizing,
    isRotating,
    openMenu,
    openPopup,
    openSidebar,
    openDialog,
    contextMenu,
    multiElement,
    newElement,
    resizingElement,
    selectionElement,
    suggestedBindings,
    frameToHighlight,
    elementsToHighlight,
    pendingImageElementId,
    showHyperlinkPopup,
    toast,
    cursorButton,
    activeEmbeddable,
    isLoading,
    errorMessage,
    ...rest
  } = appState;
  return rest;
}

export default function App() {
  const [auth, setAuth] = useState("checking"); // checking | guest | ok
  const [password, setPassword] = useState("");
  const [loginErr, setLoginErr] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  const [docs, setDocs] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [title, setTitle] = useState("");
  const [initialData, setInitialData] = useState(null);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [toast, setToast] = useState(null); // { kind: 'ok'|'err', text }

  const apiRef = useRef(null);
  const saveTimer = useRef(null);
  const toastTimer = useRef(null);
  const latestPayload = useRef(null);
  const lastSavedFp = useRef("");
  const activeIdRef = useRef(null);
  const titleRef = useRef("");
  const dirtyRef = useRef(false);
  const hydratingRef = useRef(false);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  useEffect(() => {
    titleRef.current = title;
  }, [title]);

  const showToast = useCallback((kind, text) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ kind, text });
    toastTimer.current = setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, TOAST_MS);
  }, []);

  const afterDocOpened = useCallback(() => {
    // Minimal chrome: always collapse chrome when a doc is open (mobile + desktop).
    setSidebarOpen(false);
  }, []);

  const refreshDocs = useCallback(async () => {
    const { docs: list } = await api.listDocs();
    setDocs(list || []);
    return list || [];
  }, []);

  const openDoc = useCallback(
    async (id) => {
      if (!id) return;
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      setLoadingDoc(true);
      dirtyRef.current = false;
      try {
        const { doc } = await api.getDoc(id);
        const elements = doc.elements || [];
        const appState = doc.appState || {};
        const files = doc.files || {};
        setActiveId(doc.id);
        setTitle(doc.title || "未命名画布");
        setInitialData({
          elements,
          appState: {
            ...appState,
            collaborators: undefined,
          },
          files,
          scrollToContent: true,
        });
        latestPayload.current = { elements, appState, files };
        lastSavedFp.current = persistFingerprint(elements, files, appState);
        dirtyRef.current = false;
        hydratingRef.current = true;
        afterDocOpened();
        // Adopt Excalidraw hydrate mutations as baseline; then start dirty tracking.
        window.setTimeout(() => {
          hydratingRef.current = false;
        }, 600);
      } catch (e) {
        showToast("err", e.message || "打开失败");
      } finally {
        setLoadingDoc(false);
      }
    },
    [afterDocOpened, showToast],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await api.me();
        if (cancelled) return;
        setAuth("ok");
        const list = await refreshDocs();
        if (!cancelled && list.length && !activeIdRef.current) {
          await openDoc(list[0].id);
        } else if (!cancelled && !activeIdRef.current) {
          setSidebarOpen(true);
        }
      } catch {
        if (!cancelled) setAuth("guest");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshDocs, openDoc]);

  const createDoc = useCallback(async () => {
    const { doc } = await api.createDoc("未命名画布");
    await refreshDocs();
    await openDoc(doc.id);
  }, [openDoc, refreshDocs]);

  const deleteDoc = useCallback(async () => {
    if (!activeId) return;
    if (!confirm("确定删除当前画布？此操作不可撤销。")) return;
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    await api.deleteDoc(activeId);
    setActiveId(null);
    setInitialData(null);
    setTitle("");
    latestPayload.current = null;
    lastSavedFp.current = "";
    dirtyRef.current = false;
    setSidebarOpen(true);
    await refreshDocs();
  }, [activeId, refreshDocs]);

  const flushSave = useCallback(
    async ({ force = false } = {}) => {
      const id = activeIdRef.current;
      const payload = latestPayload.current;
      if (!id || !payload) return;
      if (!force && !dirtyRef.current) return;

      const elements = payload.elements || [];
      const files = payload.files || {};
      const appState = sanitizeAppState(payload.appState);
      const fp = persistFingerprint(elements, files, appState);

      try {
        const res = await api.saveDoc(id, {
          title: titleRef.current,
          elements,
          appState,
          files,
        });
        lastSavedFp.current = fp;
        dirtyRef.current = false;
        showToast("ok", "已保存");
        setDocs((prev) =>
          prev
            .map((d) =>
              d.id === id
                ? { ...d, title: titleRef.current, updatedAt: res.updatedAt }
                : d,
            )
            .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")),
        );
      } catch (e) {
        showToast("err", e.message || "保存失败");
      }
    },
    [showToast],
  );

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      flushSave();
    }, SAVE_DEBOUNCE_MS);
  }, [flushSave]);

  const onChange = useCallback(
    (elements, appState, files) => {
      if (!activeIdRef.current) return;
      latestPayload.current = { elements, appState, files };
      const fp = persistFingerprint(elements, files, appState);
      if (fp === lastSavedFp.current) {
        // No persistable change (selection / zoom / scroll / pointer only).
        return;
      }
      if (hydratingRef.current) {
        // Initial Excalidraw hydrate often rewrites element defaults — adopt as saved.
        lastSavedFp.current = fp;
        dirtyRef.current = false;
        return;
      }
      dirtyRef.current = true;
      scheduleSave();
    },
    [scheduleSave],
  );

  const onTitleBlur = useCallback(async () => {
    if (!activeId) return;
    const t = title.trim() || "未命名画布";
    setTitle(t);
    try {
      await api.renameDoc(activeId, t);
      await flushSave({ force: true });
      await refreshDocs();
    } catch (e) {
      showToast("err", e.message || "重命名失败");
    }
  }, [activeId, title, flushSave, refreshDocs, showToast]);

  const onLogin = async (e) => {
    e.preventDefault();
    setLoggingIn(true);
    setLoginErr("");
    try {
      await api.login(password);
      setAuth("ok");
      setPassword("");
      const list = await refreshDocs();
      if (list.length) {
        await openDoc(list[0].id);
      } else {
        setSidebarOpen(true);
      }
    } catch (err) {
      setLoginErr(err.message === "invalid password" ? "密码错误" : err.message || "登录失败");
    } finally {
      setLoggingIn(false);
    }
  };

  const onLogout = async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (dirtyRef.current) {
      await flushSave({ force: true });
    }
    await api.logout();
    setAuth("guest");
    setDocs([]);
    setActiveId(null);
    setInitialData(null);
    setSidebarOpen(true);
    latestPayload.current = null;
    lastSavedFp.current = "";
    dirtyRef.current = false;
  };

  const excalidrawKey = useMemo(() => activeId || "none", [activeId]);

  const showSidebar = sidebarOpen || !activeId;
  const appClass = [
    "app",
    showSidebar ? "sidebar-open" : "sidebar-collapsed",
    activeId ? "has-doc" : "no-doc",
  ].join(" ");

  if (auth === "checking") {
    return <div className="empty">加载中…</div>;
  }

  if (auth === "guest") {
    return (
      <div className="login-wrap">
        <form className="login-card" onSubmit={onLogin}>
          <h1>Excalidraw Sync</h1>
          <p className="sub">单用户云端画布 · EdgeOne Blob 自动存盘</p>
          <p className="err">{loginErr}</p>
          <input
            type="password"
            placeholder="访问密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            autoComplete="current-password"
          />
          <button type="submit" disabled={loggingIn || !password}>
            {loggingIn ? "登录中…" : "登录"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className={appClass}>
      {showSidebar && activeId && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="关闭菜单"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside className={`sidebar ${showSidebar ? "is-open" : "is-closed"}`}>
        <div className="sidebar-head">
          <h2>{activeId ? "菜单" : "我的画布"}</h2>
          {activeId && (
            <button
              className="btn secondary"
              type="button"
              onClick={() => setSidebarOpen(false)}
              title="收起"
            >
              收起
            </button>
          )}
          <button className="btn secondary" type="button" onClick={onLogout} title="退出">
            退出
          </button>
        </div>

        {activeId && (
          <div className="panel-doc-meta">
            <input
              className="title-input"
              value={title}
              placeholder="画布名称"
              onChange={(e) => setTitle(e.target.value)}
              onBlur={onTitleBlur}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
            <button
              className="btn"
              type="button"
              onClick={() => flushSave({ force: true })}
            >
              立即保存
            </button>
          </div>
        )}

        <div className="sidebar-actions">
          <button className="btn" type="button" onClick={createDoc}>
            新建
          </button>
          <button className="btn danger" type="button" onClick={deleteDoc} disabled={!activeId}>
            删除
          </button>
        </div>
        <div className="doc-list">
          {docs.length === 0 && (
            <div className="empty" style={{ height: "auto", padding: 16 }}>
              还没有画布，点「新建」开始
            </div>
          )}
          {docs.map((d) => (
            <button
              key={d.id}
              type="button"
              className={`doc-item ${d.id === activeId ? "active" : ""}`}
              onClick={() => openDoc(d.id)}
            >
              <div className="title">{d.title || "未命名画布"}</div>
              <div className="meta">{formatTime(d.updatedAt)}</div>
            </button>
          ))}
        </div>
      </aside>

      <main className="main">
        {activeId && (
          <button
            type="button"
            className="fab-menu"
            title="画布菜单"
            aria-label="打开画布菜单"
            onClick={() => setSidebarOpen((v) => !v)}
          >
            ⋯
          </button>
        )}

        {toast && (
          <div className={`toast toast-${toast.kind}`} role="status">
            {toast.text}
          </div>
        )}

        <div className="canvas">
          {!activeId && <div className="empty">点「新建」开始，或从列表打开画布</div>}
          {activeId && loadingDoc && <div className="empty">打开画布中…</div>}
          {activeId && !loadingDoc && initialData && (
            <Excalidraw
              key={excalidrawKey}
              langCode="zh-CN"
              excalidrawAPI={(api) => {
                apiRef.current = api;
              }}
              initialData={initialData}
              onChange={onChange}
              UIOptions={{
                canvasActions: {
                  loadScene: false,
                  saveToActiveFile: false,
                },
              }}
            />
          )}
        </div>
      </main>
    </div>
  );
}
