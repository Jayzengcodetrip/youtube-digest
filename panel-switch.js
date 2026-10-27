/** Tab-scoped subtitle / transcript navigation. No transcript or key data lives here. */
(function (root) {
  "use strict";
  const PREFIX = "transcriptPanelWindow_";
  const DOCUMENT_PREFIX = "transcriptPanelDocument_";
  const INTENT_TTL = 60_000;
  const ACTIONS = new Set([
    "getTranscriptPanelState", "toggleTranscriptPanel", "transcriptPanelReady",
    "ackTranscriptPanelIntent", "closeTranscriptPanel",
  ]);
  function watchId(value) {
    try {
      const url = new URL(value);
      const id = url.searchParams.get("v");
      return url.origin === "https://www.youtube.com" && url.pathname === "/watch" &&
        /^[A-Za-z0-9_-]{11}$/.test(id || "") ? id : null;
    } catch (_) { return null; }
  }
  function create({ chrome, now = Date.now, makeId = () => crypto.randomUUID() }) {
    const states = new Map();
    const bindings = new Map();
    const operations = new Map();
    const writes = new Map();
    const nativeRevisions = new Map();
    const nativeTargets = new Map();
    const activationRevisions = new Map();
    const storage = chrome.storage.session;
    const hydration = storage.get(null).then((stored) => {
      for (const [key, value] of Object.entries(stored)) {
        if (key.startsWith(PREFIX) && value && Number.isInteger(value.windowId) && !states.has(value.windowId)) {
          states.set(value.windowId, value);
        }
        if (key.startsWith(DOCUMENT_PREFIX) && Number.isInteger(value)) {
          bindings.set(key.slice(DOCUMENT_PREFIX.length), value);
        }
      }
    });
    // The message path still surfaces storage failures; this prevents an idle
    // worker's initial read from creating an unhandled rejection.
    hydration.catch(() => {});
    const persist = (state) => {
      const snapshot = { ...state, intent: state.intent ? { ...state.intent } : null };
      const previous = writes.get(state.windowId) || Promise.resolve();
      const next = previous.catch(() => {}).then(() => storage.set({ [`${PREFIX}${state.windowId}`]: snapshot }));
      writes.set(state.windowId, next);
      return next;
    };
    const emptyState = (windowId) => ({ windowId, tabId: null, videoId: null, open: false, intent: null });
    const stateFor = (windowId) => {
      if (!states.has(windowId)) states.set(windowId, emptyState(windowId));
      return states.get(windowId);
    };
    const isPanel = (sender) => {
      // Native side panels do not consistently include a documentId in their
      // MessageSender. Resolve their live extension context below instead of
      // treating that optional messaging field as proof of panel identity.
      if (sender?.id !== chrome.runtime.id || sender.tab) return false;
      try {
        const url = new URL(sender.url);
        return url.protocol === "chrome-extension:" && url.host === chrome.runtime.id && url.pathname === "/sidepanel.html";
      } catch (_) { return false; }
    };
    function assertContent(sender, videoId) {
      let senderOrigin;
      try { senderOrigin = new URL(sender?.url).origin; } catch (_) { /* Reject malformed sender URLs below. */ }
      // A content script keeps its original document URL across YouTube's
      // history navigation. Authenticate that origin, then use Chrome's tab
      // URL for the current video without delaying the click's open() call.
      if (sender?.id !== chrome.runtime.id || sender.frameId !== 0 ||
          !Number.isInteger(sender.tab?.id) || !Number.isInteger(sender.tab?.windowId) ||
          senderOrigin !== "https://www.youtube.com" ||
          (sender.origin !== undefined && sender.origin !== senderOrigin) ||
          !videoId || watchId(sender.tab.url) !== videoId) {
        throw new Error("逐字稿请求与当前视频不匹配，请刷新视频页面后重试。");
      }
      return sender.tab;
    }
    async function currentTab(tabId, videoId, windowId) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId !== windowId || tab.active === false || !watchId(tab.url) || (videoId && watchId(tab.url) !== videoId)) {
        throw new Error("视频已切换，请在当前视频重新打开逐字稿。");
      }
      return tab;
    }
    async function assertPanelWindow(sender, windowId, register = false) {
      if (!isPanel(sender) || !Number.isInteger(windowId)) throw new Error("仅当前窗口的逐字稿面板可以执行此操作。");
      await hydration;
      const senderBound = sender.documentId ? bindings.get(sender.documentId) : undefined;
      if (senderBound !== undefined && senderBound !== windowId) throw new Error("逐字稿面板不属于此窗口。");
      // Check Chrome's actual SIDE_PANEL views. Each panel sets a unique URL
      // query parameter before sending readiness, because native MessageSender can
      // omit documentId and getContexts may report windowId: -1 for side panels.
      // An extension tab at this URL or a stale document is not a panel binding.
      const filter = {
        contextTypes: ["SIDE_PANEL"], documentUrls: [sender.url],
        ...(sender.documentId ? { documentIds: [sender.documentId] } : {}),
      };
      const contexts = await chrome.runtime.getContexts(filter);
      const matches = contexts.filter((context) => context.contextType === "SIDE_PANEL" &&
        context.documentUrl === sender.url &&
        (!sender.documentId || context.documentId === sender.documentId));
      if (matches.length !== 1) {
        throw new Error(register ? "无法确认当前窗口的逐字稿面板，请重新打开。" : "逐字稿面板尚未准备好，请重新打开。");
      }
      const context = matches[0];
      if (Number.isInteger(context.windowId) && context.windowId >= 0 && context.windowId !== windowId) {
        throw new Error("逐字稿面板不属于此窗口。");
      }
      const bindingKey = context.documentId || (context.contextId ? `context:${context.contextId}` : null);
      if (!bindingKey) throw new Error("无法确认逐字稿面板身份，请重新打开。");
      const bound = bindings.get(bindingKey);
      if (bound !== undefined && bound !== windowId) throw new Error("逐字稿面板不属于此窗口。");
      if (bound === undefined) {
        if (!register) throw new Error("逐字稿面板尚未准备好，请重新打开。");
        // The authenticated own panel obtains this ID from windows.getCurrent;
        // verify existence before persisting the actual document's binding.
        const window = await chrome.windows.get(windowId);
        if (window.id !== windowId) throw new Error("逐字稿面板不属于此窗口。");
        bindings.set(bindingKey, windowId);
        await storage.set({ [`${DOCUMENT_PREFIX}${bindingKey}`]: windowId });
      }
      return windowId;
    }
    async function assertPanelTarget(sender, { windowId, tabId, videoId }) {
      await hydration;
      const actualWindow = Number.isInteger(windowId) ? windowId : bindings.get(sender?.documentId);
      await assertPanelWindow(sender, actualWindow);
      if (!Number.isInteger(tabId)) throw new Error("逐字稿尚未绑定视频标签页。");
      return currentTab(tabId, videoId, actualWindow);
    }
    async function notifyTab(tabId, open, expectedVideoId) {
      if (!Number.isInteger(tabId)) return;
      try {
        const tab = await chrome.tabs.get(tabId);
        const videoId = watchId(tab.url);
        if (!videoId || (expectedVideoId && videoId !== expectedVideoId)) return;
        await chrome.tabs.sendMessage(tabId, { action: "transcriptPanelState", open, videoId }, { frameId: 0 });
      } catch (_) { /* Navigated or removed tabs no longer have the content receiver. */ }
    }
    async function publish(state, oldTabId = null) {
      await persist(state);
      if (Number.isInteger(oldTabId) && oldTabId !== state.tabId) await notifyTab(oldTabId, false);
      await notifyTab(state.tabId, state.open, state.videoId);
    }
    function expireIntent(state) {
      if (state.intent && now() - state.intent.createdAt > INTENT_TTL) {
        state.intent = null;
        void persist(state).catch(() => {});
      }
      return state.intent;
    }
    async function validIntent(state) {
      const intent = expireIntent(state);
      if (!intent) return null;
      try { await currentTab(intent.tabId, intent.videoId, intent.windowId); }
      catch (_) {
        if (state.intent?.requestId === intent.requestId) {
          state.intent = null;
          await persist(state);
        }
        return null;
      }
      return state.open && state.intent?.requestId === intent.requestId ? intent : null;
    }
    async function deliver(state) {
      const intent = await validIntent(state);
      if (!intent) return;
      // Every panel filters by its own window. A newly loading panel instead
      // retrieves this same durable intent through transcriptPanelReady.
      await chrome.runtime.sendMessage({ action: "focusSubtitleTranscript", intent }).catch(() => {});
    }
    async function getState(message, sender) {
      const tab = assertContent(sender, message.videoId);
      await hydration;
      await currentTab(tab.id, message.videoId, tab.windowId);
      const state = stateFor(tab.windowId);
      expireIntent(state);
      return { success: true, open: state.open && state.tabId === tab.id, videoId: message.videoId };
    }
    function toggle(message, sender) {
      const tab = assertContent(sender, message.videoId);
      if (message.source !== "subtitle") throw new Error("未知的逐字稿入口。");
      const existing = operations.get(tab.windowId);
      // Opening needs no persisted state, so do not replace a state that is
      // still hydrating. Closing may safely wait; it has no gesture requirement.
      let state = states.get(tab.windowId) || emptyState(tab.windowId);
      const shouldOpen = typeof message.open === "boolean" ? message.open : !(state.open && state.tabId === tab.id);
      if (existing && existing.videoId === message.videoId && existing.tabId === tab.id && existing.opening === shouldOpen) return existing.promise;
      if (existing) existing.cancelled = true;
      const operation = { tabId: tab.id, videoId: message.videoId, cancelled: false, opening: shouldOpen };
      operations.set(tab.windowId, operation);
      let apiPromise;
      try {
        // Must happen in the original runtime message stack, BEFORE storage,
        // tabs.get, or any await: sidePanel.open requires the click gesture.
        if (shouldOpen) {
          void chrome.sidePanel.setOptions({ tabId: tab.id, path: "sidepanel.html", enabled: true }).catch(() => {});
          apiPromise = chrome.sidePanel.open({ tabId: tab.id });
        } else {
          apiPromise = hydration.then(() => {
            state = stateFor(tab.windowId);
            return chrome.sidePanel.close(state.global ? { windowId: tab.windowId } : { tabId: tab.id });
          });
        }
      } catch (error) { apiPromise = Promise.reject(error); }
      operation.promise = (async () => {
        await apiPromise;
        await hydration;
        state = stateFor(tab.windowId);
        await currentTab(tab.id, message.videoId, tab.windowId);
        if (operation.cancelled || operations.get(tab.windowId) !== operation) throw new Error("逐字稿切换请求已过期，请重试。");
        const oldTabId = state.tabId;
        state.tabId = tab.id;
        state.videoId = message.videoId;
        state.open = shouldOpen;
        if (shouldOpen) state.global = false;
        state.intent = shouldOpen ? {
          requestId: makeId(), windowId: tab.windowId, tabId: tab.id,
          videoId: message.videoId, source: "subtitle", createdAt: now(),
        } : null;
        await publish(state, oldTabId);
        if (operation.cancelled || operations.get(tab.windowId) !== operation) throw new Error("逐字稿切换请求已过期，请重试。");
        if (shouldOpen) await deliver(state);
        if (operation.cancelled || operations.get(tab.windowId) !== operation) throw new Error("逐字稿切换请求已过期，请重试。");
        return { success: true, open: shouldOpen, requestId: state.intent?.requestId };
      })().finally(() => {
        if (operations.get(tab.windowId) === operation) operations.delete(tab.windowId);
      });
      return operation.promise;
    }
    async function ready(message, sender) {
      await assertPanelWindow(sender, message.windowId, true);
      const state = stateFor(message.windowId);
      const intent = await validIntent(state);
      return { success: true, windowId: message.windowId, open: state.open, tabId: state.tabId, videoId: state.videoId, intent };
    }
    async function acknowledge(message, sender) {
      await assertPanelWindow(sender, message.windowId);
      const state = stateFor(message.windowId);
      const intent = await validIntent(state);
      if (!intent || intent.requestId !== message.requestId || intent.videoId !== message.videoId ||
          (message.tabId !== undefined && message.tabId !== intent.tabId)) {
        return { success: false, error: "逐字稿定位请求已过期。" };
      }
      state.intent = null;
      await persist(state);
      return { success: true };
    }
    async function close(message, sender) {
      const tab = await assertPanelTarget(sender, message);
      const state = stateFor(tab.windowId);
      if (state.tabId !== tab.id || state.videoId !== message.videoId) throw new Error("当前面板已切换到其他视频。");
      const operation = operations.get(tab.windowId);
      if (operation) operation.cancelled = true;
      await chrome.sidePanel.close(state.global ? { windowId: tab.windowId } : { tabId: tab.id });
      state.open = false;
      state.intent = null;
      await publish(state);
      return { success: true, open: false };
    }
    function handle(message, sender) {
      switch (message.action) {
        case "getTranscriptPanelState": return getState(message, sender);
        case "toggleTranscriptPanel": return toggle(message, sender);
        case "transcriptPanelReady": return ready(message, sender);
        case "ackTranscriptPanelIntent": return acknowledge(message, sender);
        case "closeTranscriptPanel": return close(message, sender);
        default: throw new Error("Unknown transcript panel action");
      }
    }
    async function opened(info) {
      const revision = (nativeRevisions.get(info.windowId) || 0) + 1;
      nativeRevisions.set(info.windowId, revision);
      nativeTargets.set(info.windowId, { tabId: info.tabId, open: true });
      await hydration;
      let tab;
      if (Number.isInteger(info.tabId)) tab = await chrome.tabs.get(info.tabId);
      else [tab] = await chrome.tabs.query({ active: true, windowId: info.windowId });
      if (!tab || tab.active === false || tab.windowId !== info.windowId || nativeRevisions.get(info.windowId) !== revision) return;
      const state = stateFor(info.windowId);
      const oldTabId = state.tabId;
      if (state.tabId !== tab.id || state.videoId !== watchId(tab.url)) state.intent = null;
      state.tabId = tab.id;
      state.videoId = watchId(tab.url);
      state.open = true;
      state.global = !Number.isInteger(info.tabId);
      await publish(state, oldTabId);
    }
    async function closed(info) {
      const target = nativeTargets.get(info.windowId);
      if (target?.open && Number.isInteger(target.tabId) && Number.isInteger(info.tabId) && target.tabId !== info.tabId) return;
      const revision = (nativeRevisions.get(info.windowId) || 0) + 1;
      nativeRevisions.set(info.windowId, revision);
      nativeTargets.set(info.windowId, { tabId: info.tabId, open: false });
      await hydration;
      if (nativeRevisions.get(info.windowId) !== revision) return;
      const state = stateFor(info.windowId);
      const operation = operations.get(info.windowId);
      if (Number.isInteger(info.tabId) && state.tabId !== info.tabId && operation?.tabId !== info.tabId && state.tabId !== null) return;
      if (operation?.opening) operation.cancelled = true;
      state.open = false;
      state.intent = null;
      await publish(state);
    }
    async function navigated(tabId, changeInfo, tab) {
      if (!changeInfo.url && changeInfo.status !== "loading") return;
      await hydration;
      const videoId = watchId(changeInfo.url || tab.pendingUrl || tab.url);
      const operation = operations.get(tab.windowId);
      if (operation?.tabId === tabId && operation.videoId !== videoId) operation.cancelled = true;
      const state = stateFor(tab.windowId);
      if (state.tabId !== tabId || state.videoId === videoId) return;
      state.intent = null;
      state.videoId = videoId;
      if (!videoId) state.open = false;
      await publish(state);
    }
    async function activated({ tabId, windowId }) {
      const revision = (activationRevisions.get(windowId) || 0) + 1;
      activationRevisions.set(windowId, revision);
      const nativeRevision = nativeRevisions.get(windowId);
      const operation = operations.get(windowId);
      if (operation && operation.tabId !== tabId) operation.cancelled = true;
      await hydration;
      const state = stateFor(windowId);
      if (state.intent && state.intent.tabId !== tabId) {
        state.intent = null;
        await persist(state);
      }
      // A window-wide panel stays open when its active tab changes. Chrome
      // need not emit onOpened again, so move the binding to that live video.
      if (!state.open || !state.global) return;
      const tab = await chrome.tabs.get(tabId);
      if (activationRevisions.get(windowId) !== revision || nativeRevisions.get(windowId) !== nativeRevision ||
          !state.open || !state.global || tab.active === false || tab.windowId !== windowId || !watchId(tab.url)) return;
      const oldTabId = state.tabId;
      state.tabId = tab.id;
      state.videoId = watchId(tab.url);
      state.intent = null;
      await publish(state, oldTabId);
    }
    async function removed(tabId) {
      await hydration;
      for (const [windowId, operation] of operations) if (operation.tabId === tabId) operation.cancelled = true;
      for (const state of states.values()) if (state.tabId === tabId) {
        state.tabId = null;
        state.videoId = null;
        state.open = false;
        state.intent = null;
        await persist(state);
      }
    }
    const listen = (event, fn) => event?.addListener((...args) => { void fn(...args).catch(() => {}); });
    listen(chrome.sidePanel.onOpened, opened);
    listen(chrome.sidePanel.onClosed, closed);
    listen(chrome.tabs.onUpdated, navigated);
    listen(chrome.tabs.onActivated, activated);
    listen(chrome.tabs.onRemoved, removed);
    return { handles: (action) => ACTIONS.has(action), handle, assertPanelTarget };
  }
  const api = { create };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.YTD_PANEL_SWITCH = api;
})(globalThis);
