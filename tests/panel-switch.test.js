const test = require("node:test");
const assert = require("node:assert/strict");
const factory = require("../panel-switch.js");
const VIDEO = "abcdefghijk";
const OTHER = "lmnopqrstuv";
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function event() {
  const listeners = [];
  return { addListener(fn) { listeners.push(fn); }, fire(...args) { for (const fn of listeners) fn(...args); } };
}
function fixture(initial = {}) {
  const data = structuredClone(initial);
  const calls = [];
  const broadcasts = [];
  const contentEvents = [];
  const tabs = new Map([
    [11, { id: 11, windowId: 1, url: `https://www.youtube.com/watch?v=${VIDEO}`, active: true }],
    [22, { id: 22, windowId: 2, url: `https://www.youtube.com/watch?v=${OTHER}`, active: true }],
  ]);
  let currentTime = 1_800_000_000_000;
  let requestCount = 0;
  const contexts = new Map([1, 2].map((windowId) => [`panel-${windowId}`, {
    contextId: `context-${windowId}`, documentId: `panel-${windowId}`,
    contextType: "SIDE_PANEL", windowId, tabId: -1,
    documentUrl: `chrome-extension://digest-extension/sidepanel.html#ytd-panel=panel-${windowId}`,
  }]));
  const chrome = {
    runtime: {
      id: "digest-extension", sendMessage: async (message) => { broadcasts.push(message); },
      async getContexts(filter) {
        return structuredClone([...contexts.values()].filter((context) =>
          Object.entries({ contextTypes: "contextType", documentUrls: "documentUrl", windowIds: "windowId", documentIds: "documentId" })
            .every(([filterKey, key]) => !filter[filterKey] || filter[filterKey].includes(context[key]))));
      },
    },
    storage: { session: {
      async get(key) { return key === null ? structuredClone(data) : { [key]: structuredClone(data[key]) }; },
      async set(values) { Object.assign(data, structuredClone(values)); },
    } },
    windows: { get: async (id) => { if (![1, 2].includes(id)) throw new Error("Missing window"); return { id }; } },
    tabs: {
      async get(id) { if (!tabs.has(id)) throw new Error("Missing tab"); return structuredClone(tabs.get(id)); },
      async query(query) { return [...tabs.values()].filter((tab) => tab.windowId === query.windowId && tab.active); },
      async sendMessage(tabId, message) { contentEvents.push({ tabId, message }); },
      onUpdated: event(), onRemoved: event(), onActivated: event(),
    },
    sidePanel: {
      setOptions(options) { calls.push({ method: "setOptions", options }); return Promise.resolve(); },
      open(options) { calls.push({ method: "open", options }); return Promise.resolve(); },
      close(options) { calls.push({ method: "close", options }); return Promise.resolve(); },
      onOpened: event(), onClosed: event(),
    },
  };
  const deps = { chrome, now: () => currentTime, makeId: () => `intent-${++requestCount}` };
  const service = factory.create(deps);
  const content = (id = 11) => ({ id: chrome.runtime.id, frameId: 0, tab: structuredClone(tabs.get(id)), url: tabs.get(id).url });
  const panel = (documentId = "panel-1") => ({ id: chrome.runtime.id, documentId, url: `chrome-extension://${chrome.runtime.id}/sidepanel.html#ytd-panel=${documentId}` });
  const toggle = (id = 11, open = true) => service.handle({ action: "toggleTranscriptPanel", source: "subtitle", open, videoId: id === 11 ? VIDEO : OTHER }, content(id));
  const ready = (windowId = 1, documentId = "panel-1") => service.handle({ action: "transcriptPanelReady", windowId }, panel(documentId));
  return { service, chrome, deps, data, tabs, contexts, calls, broadcasts, contentEvents, content, panel, toggle, ready, advance(ms) { currentTime += ms; } };
}

test("native sidepanel sender without documentId binds the live SIDE_PANEL context and survives worker restart", async () => {
  const f = fixture();
  const sender = f.panel();
  delete sender.documentId;
  f.contexts.get("panel-1").windowId = -1;
  f.contexts.get("panel-2").windowId = -1;
  await f.toggle();
  const readyMessage = { action: "transcriptPanelReady", windowId: 1 };
  const result = await f.service.handle(readyMessage, sender);
  assert.equal(result.success, true);
  assert.equal(result.intent.videoId, VIDEO);
  assert.equal(f.data["transcriptPanelDocument_panel-1"], 1);
  const target = { windowId: 1, tabId: 11, videoId: VIDEO };
  assert.equal((await f.service.assertPanelTarget(sender, target)).id, 11);
  const restarted = factory.create(f.deps);
  assert.equal((await restarted.assertPanelTarget(sender, target)).id, 11);
  assert.equal((await restarted.handle(readyMessage, sender)).intent.requestId, result.intent.requestId);
  assert.equal((await restarted.handle({ action: "closeTranscriptPanel", ...target }, sender)).open, false);
});

test("panel context checks reject absent, wrong-window, stale, ordinary-tab, ambiguous and foreign senders", async () => {
  const f = fixture();
  const sender = f.panel();
  delete sender.documentId;
  const readyMessage = { action: "transcriptPanelReady", windowId: 1 };
  await assert.rejects(f.service.handle(readyMessage, { ...sender, id: "foreign" }), /仅当前窗口/);
  await assert.rejects(f.service.handle(readyMessage, f.content()), /仅当前窗口/);
  await assert.rejects(f.service.handle(readyMessage, { ...sender, tab: { id: 11 } }), /仅当前窗口/);
  await assert.rejects(f.service.handle(readyMessage, { ...sender, url: "chrome-extension://digest-extension/options.html" }), /仅当前窗口/);
  await assert.rejects(f.service.handle({ ...readyMessage, windowId: 3 }, sender), /不属于/);
  await assert.rejects(f.service.handle(readyMessage, f.panel("panel-2")), /不属于/);
  f.contexts.get("panel-1").contextType = "TAB";
  await assert.rejects(f.service.handle(readyMessage, sender), /无法确认/);
  f.contexts.get("panel-1").contextType = "SIDE_PANEL";
  const duplicate = { ...f.contexts.get("panel-1"), contextId: "second-context", documentId: "second-document" };
  f.contexts.set("duplicate", duplicate);
  await assert.rejects(f.service.handle(readyMessage, sender), /无法确认/);
  f.contexts.delete("duplicate");
  await f.service.handle(readyMessage, sender);
  f.contexts.delete("panel-1");
  await assert.rejects(f.service.assertPanelTarget(sender, { windowId: 1, tabId: 11, videoId: VIDEO }), /尚未准备好/);
});

test("native contexts with unknown window IDs use unique URLs and cannot rebind to another window", async () => {
  const f = fixture();
  for (const context of f.contexts.values()) context.windowId = -1;
  const firstSender = f.panel("panel-1");
  const secondSender = f.panel("panel-2");
  delete firstSender.documentId;
  delete secondSender.documentId;
  await assert.rejects(f.service.handle({ action: "transcriptPanelReady", windowId: 3 }, firstSender), /Missing window/);
  await f.service.handle({ action: "transcriptPanelReady", windowId: 1 }, firstSender);
  await f.service.handle({ action: "transcriptPanelReady", windowId: 2 }, secondSender);
  assert.equal((await f.service.assertPanelTarget(firstSender, { windowId: 1, tabId: 11, videoId: VIDEO })).id, 11);
  assert.equal((await f.service.assertPanelTarget(secondSender, { windowId: 2, tabId: 22, videoId: OTHER })).id, 22);
  await assert.rejects(f.service.handle({ action: "transcriptPanelReady", windowId: 2 }, firstSender), /不属于/);
  const restarted = factory.create(f.deps);
  await assert.rejects(restarted.assertPanelTarget(firstSender, { windowId: 2, tabId: 22, videoId: OTHER }), /不属于/);
});

test("missing sender document ID never guesses another window for a targeted relay", async () => {
  const f = fixture();
  const sender = f.panel();
  delete sender.documentId;
  await f.service.handle({ action: "transcriptPanelReady", windowId: 1 }, sender);
  await assert.rejects(f.service.assertPanelTarget(sender, { tabId: 11, videoId: VIDEO }), /仅当前窗口/);
  await assert.rejects(f.service.assertPanelTarget(sender, { windowId: 1, tabId: 22, videoId: OTHER }), /视频已切换/);
  // Supplying the other live window is still insufficient to target this tab.
  await assert.rejects(f.service.assertPanelTarget(sender, { windowId: 2, tabId: 11, videoId: VIDEO }), /不属于/);
});

test("a live context ID can bind the panel if both native records omit documentId", async () => {
  const f = fixture();
  const sender = f.panel();
  delete sender.documentId;
  delete f.contexts.get("panel-1").documentId;
  await f.service.handle({ action: "transcriptPanelReady", windowId: 1 }, sender);
  assert.equal(f.data["transcriptPanelDocument_context:context-1"], 1);
  assert.equal((await f.service.assertPanelTarget(sender, { windowId: 1, tabId: 11, videoId: VIDEO })).id, 11);
});

test("open enters Chrome API synchronously before storage or tab reads, and reports actual API failure", async () => {
  const f = fixture();
  const gate = deferred();
  f.chrome.sidePanel.open = (options) => { f.calls.push({ method: "open", options }); return gate.promise; };
  let settled = false;
  const request = f.toggle().finally(() => { settled = true; });
  assert.deepEqual(f.calls.map((call) => call.method), ["setOptions", "open"]);
  assert.deepEqual(f.calls[1].options, { tabId: 11 });
  await tick();
  assert.equal(settled, false);
  assert.equal(f.broadcasts.length, 0);
  gate.reject(new Error("User gesture expired"));
  await assert.rejects(request, /User gesture expired/);
  assert.equal((await f.service.handle({ action: "getTranscriptPanelState", videoId: VIDEO }, f.content())).open, false);
});

test("existing and late-loading panels receive the same exact window/video intent without timers", async () => {
  const f = fixture();
  assert.equal((await f.ready()).intent, null);
  const result = await f.toggle();
  const sent = f.broadcasts.at(-1);
  assert.equal(sent.action, "focusSubtitleTranscript");
  const ready = await f.ready();
  assert.deepEqual(ready.intent, sent.intent);
  assert.deepEqual({ ...ready.intent, createdAt: 0 }, { requestId: result.requestId, windowId: 1, tabId: 11, videoId: VIDEO, source: "subtitle", createdAt: 0 });
  assert.deepEqual(f.contentEvents.at(-1), { tabId: 11, message: { action: "transcriptPanelState", open: true, videoId: VIDEO } });
  assert.equal((await f.ready(2, "panel-2")).intent, null);
});

test("panel readiness survives worker restart through session storage; exact acknowledgment consumes once", async () => {
  const f = fixture();
  await f.toggle();
  const first = await f.ready();
  const restarted = factory.create(f.deps);
  const restored = await restarted.handle({ action: "transcriptPanelReady", windowId: 1 }, f.panel());
  assert.deepEqual(restored.intent, first.intent);
  const ack = { action: "ackTranscriptPanelIntent", windowId: 1, requestId: first.intent.requestId, videoId: VIDEO, tabId: 11 };
  assert.equal((await restarted.handle({ ...ack, videoId: OTHER }, f.panel())).success, false);
  assert.equal((await restarted.handle(ack, f.panel())).success, true);
  assert.equal((await restarted.handle(ack, f.panel())).success, false);
});

test("YouTube SPA navigation from home, channel and another video still opens the current transcript synchronously", async () => {
  for (const initialUrl of ["https://www.youtube.com/", "https://www.youtube.com/@wangzhian/videos", `https://www.youtube.com/watch?v=${OTHER}`]) {
    for (const origin of [undefined, "https://www.youtube.com"]) {
      const f = fixture();
      const sender = { ...f.content(), url: initialUrl, ...(origin ? { origin } : {}) };
      const message = { action: "toggleTranscriptPanel", source: "subtitle", videoId: VIDEO, open: true };
      const opening = f.service.handle(message, sender);
      assert.deepEqual(f.calls.map((call) => call.method), ["setOptions", "open"]);
      assert.equal((await opening).open, true);
      assert.equal((await f.ready()).intent.videoId, VIDEO);
      assert.equal((await f.service.handle({ action: "getTranscriptPanelState", videoId: VIDEO }, sender)).open, true);
      assert.equal((await f.service.handle({ ...message, open: false }, sender)).open, false);
    }
  }
});

test("invalid content frames, extension senders, origins and mismatched videos never reach Chrome open", async () => {
  const f = fixture();
  const message = { action: "toggleTranscriptPanel", source: "subtitle", videoId: VIDEO, open: true };
  const sender = f.content();
  for (const invalid of [
    undefined, { ...sender, id: "foreign" }, { ...sender, frameId: 1 },
    { ...sender, url: `https://youtube.com.evil/watch?v=${VIDEO}` },
    { ...sender, url: "not a URL" }, { ...sender, url: undefined },
    { ...sender, url: "http://www.youtube.com/" },
    { ...sender, origin: "https://youtube.com.evil" }, { ...sender, origin: "null" },
    { ...sender, tab: { ...sender.tab, url: `https://www.youtube.com/watch?v=${OTHER}` } }, f.panel(),
  ]) {
    assert.throws(() => f.service.handle(message, invalid), /不匹配/);
  }
  assert.equal(f.calls.length, 0);
});

test("targeted panel relays and close are bound to their own window and exact current video", async () => {
  const f = fixture();
  await f.toggle();
  await f.ready();
  const target = { windowId: 1, tabId: 11, videoId: VIDEO };
  assert.equal((await f.service.assertPanelTarget(f.panel(), target)).id, 11);
  await assert.rejects(f.service.assertPanelTarget(f.panel(), { ...target, windowId: 2, tabId: 22, videoId: OTHER }), /不属于/);
  await assert.rejects(f.service.assertPanelTarget(f.panel(), { ...target, tabId: 22 }), /视频已切换/);
  await assert.rejects(f.service.assertPanelTarget(f.content(), target), /仅当前窗口/);
  await assert.rejects(f.service.handle({ action: "closeTranscriptPanel", ...target }, f.panel("not-ready")), /尚未准备好/);
  const closed = await f.service.handle({ action: "closeTranscriptPanel", ...target }, f.panel());
  assert.deepEqual(closed, { success: true, open: false });
  assert.deepEqual(f.calls.at(-1), { method: "close", options: { tabId: 11 } });
});

test("native close button updates the correct video only and discards pending focus", async () => {
  const f = fixture();
  await f.toggle();
  await f.toggle(22);
  f.chrome.sidePanel.onClosed.fire({ windowId: 1, tabId: 11 });
  await tick();
  assert.equal((await f.ready()).intent, null);
  assert.equal((await f.service.handle({ action: "getTranscriptPanelState", videoId: VIDEO }, f.content())).open, false);
  assert.equal((await f.service.handle({ action: "getTranscriptPanelState", videoId: OTHER }, f.content(22))).open, true);
});

test("rapid repeated clicks share the in-flight open and one focus intent", async () => {
  const f = fixture();
  const gate = deferred();
  f.chrome.sidePanel.open = (options) => { f.calls.push({ method: "open", options }); return gate.promise; };
  const first = f.toggle();
  const second = f.toggle();
  assert.equal(first, second);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(f.calls.filter((call) => call.method === "open").length, 1);
  assert.equal(f.broadcasts.length, 1);
});

test("a video's navigation invalidates an unfinished open and cannot deliver stale focus", async () => {
  const f = fixture();
  const gate = deferred();
  f.chrome.sidePanel.open = () => gate.promise;
  const request = f.toggle();
  f.tabs.get(11).url = `https://www.youtube.com/watch?v=${OTHER}`;
  f.chrome.tabs.onUpdated.fire(11, { url: f.tabs.get(11).url }, f.tabs.get(11));
  gate.resolve();
  await assert.rejects(request, /视频已切换|过期/);
  assert.equal(f.broadcasts.length, 0);
  assert.equal((await f.ready()).intent, null);
});

test("native close while open is resolving cannot resurrect a panel or its focus request", async () => {
  const f = fixture();
  const gate = deferred();
  f.chrome.sidePanel.open = () => gate.promise;
  const request = f.toggle();
  f.chrome.sidePanel.onClosed.fire({ windowId: 1, tabId: 11 });
  await tick();
  gate.resolve();
  await assert.rejects(request, /过期/);
  assert.equal(f.broadcasts.length, 0);
});

test("old native open event delayed by tab reads cannot undo a newer close", async () => {
  const f = fixture();
  await f.ready();
  const originalGet = f.chrome.tabs.get;
  const gate = deferred();
  f.chrome.tabs.get = async (id) => { await gate.promise; return originalGet(id); };
  f.chrome.sidePanel.onOpened.fire({ windowId: 1, tabId: 11 });
  await tick();
  f.chrome.sidePanel.onClosed.fire({ windowId: 1, tabId: 11 });
  gate.resolve();
  await tick();
  assert.equal((await f.ready()).open, false);
});

test("native global panel open is scoped by window and closes with that same window id", async () => {
  const f = fixture();
  f.chrome.sidePanel.onOpened.fire({ windowId: 2 });
  await tick();
  await f.ready(2, "panel-2");
  assert.equal((await f.service.handle({ action: "getTranscriptPanelState", videoId: OTHER }, f.content(22))).open, true);
  await f.service.handle({ action: "closeTranscriptPanel", windowId: 2, tabId: 22, videoId: OTHER }, f.panel("panel-2"));
  assert.deepEqual(f.calls.at(-1), { method: "close", options: { windowId: 2 } });
});

test("expired intents, changed video and removed tabs never refocus stale content", async () => {
  const f = fixture();
  await f.toggle();
  f.advance(61_000);
  assert.equal((await f.ready()).intent, null);
  await f.toggle();
  f.tabs.get(11).url = `https://www.youtube.com/watch?v=${OTHER}`;
  assert.equal((await f.ready()).intent, null);
  f.chrome.tabs.onRemoved.fire(11);
  await tick();
  const state = await f.ready();
  assert.equal(state.open, false);
  assert.equal(state.tabId, null);
});

test("explicit close after a worker restart restores and closes the stored tab target", async () => {
  const f = fixture();
  await f.toggle();
  const restarted = factory.create(f.deps);
  const request = restarted.handle({ action: "toggleTranscriptPanel", source: "subtitle", open: false, videoId: VIDEO }, f.content());
  assert.equal((await request).open, false);
  assert.equal(f.calls.at(-1).method, "close");
});


test("a close click supersedes a still-pending open instead of applying the old final state", async () => {
  const f = fixture();
  const gate = deferred();
  f.chrome.sidePanel.open = () => gate.promise;
  const opening = f.toggle();
  const closing = f.toggle(11, false);
  assert.equal((await closing).open, false);
  gate.resolve();
  await assert.rejects(opening, /过期/);
  assert.equal((await f.ready()).open, false);
  assert.equal(f.broadcasts.length, 0);
});

test("a delayed close from the old tab cannot erase another tab's newer panel binding", async () => {
  const f = fixture();
  await f.toggle();
  f.tabs.set(33, { id: 33, windowId: 1, url: `https://www.youtube.com/watch?v=${OTHER}`, active: true });
  await f.service.handle({ action: "toggleTranscriptPanel", source: "subtitle", videoId: OTHER, open: true }, f.content(33));
  f.chrome.sidePanel.onClosed.fire({ windowId: 1, tabId: 11 });
  await tick();
  const result = await f.ready();
  assert.equal(result.open, true);
  assert.equal(result.intent.videoId, OTHER);
  assert.equal(result.tabId, 33);
});


test("a stored global panel survives worker hydration and closes by window after restart", async () => {
  const f = fixture();
  f.chrome.sidePanel.onOpened.fire({ windowId: 1 });
  await tick();
  const restarted = factory.create(f.deps);
  const result = await restarted.handle({ action: "toggleTranscriptPanel", source: "subtitle", videoId: VIDEO, open: false }, f.content());
  assert.equal(result.open, false);
  assert.deepEqual(f.calls.at(-1), { method: "close", options: { windowId: 1 } });
});

test("an earlier native close queued at startup cannot overwrite the latest opened event", async () => {
  const f = fixture();
  f.chrome.sidePanel.onClosed.fire({ windowId: 1, tabId: 11 });
  f.chrome.sidePanel.onOpened.fire({ windowId: 1, tabId: 11 });
  await tick();
  assert.equal((await f.ready()).open, true);
});

test("switching active tabs invalidates a pending subtitle focus and rejects relays to background tabs", async () => {
  const f = fixture();
  await f.toggle();
  f.tabs.get(11).active = false;
  f.tabs.set(33, { id: 33, windowId: 1, url: `https://www.youtube.com/watch?v=${OTHER}`, active: true });
  f.chrome.tabs.onActivated.fire({ windowId: 1, tabId: 33 });
  await tick();
  assert.equal((await f.ready()).intent, null);
  await assert.rejects(f.service.assertPanelTarget(f.panel(), { windowId: 1, tabId: 11, videoId: VIDEO }), /视频已切换/);
});


test("background dispatch calls the coordinator in the original message stack and reports failures honestly", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const f = fixture();
  const listeners = [];
  f.chrome.runtime.onMessage = { addListener(fn) { listeners.push(fn); } };
  f.chrome.runtime.onInstalled = event();
  f.chrome.action = { onClicked: event() };
  f.chrome.sidePanel.setPanelBehavior = () => {};
  f.chrome.storage.local = { setAccessLevel: async () => {} };
  const context = {
    chrome: f.chrome, console, URL, setTimeout, clearTimeout,
    importScripts() {}, YTD_PANEL_SWITCH: { create: () => f.service },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), context);
  const gate = deferred();
  f.chrome.sidePanel.open = (options) => { f.calls.push({ method: "open", options }); return gate.promise; };
  let response;
  assert.equal(listeners[0]({ action: "toggleTranscriptPanel", source: "subtitle", videoId: VIDEO, open: true }, f.content(), (value) => { response = value; }), true);
  assert.equal(f.calls.at(-1).method, "open");
  assert.equal(response, undefined);
  gate.reject(new Error("Cannot open panel"));
  await tick();
  assert.equal(response.success, false);
  assert.equal(response.error, "Cannot open panel");
});

test('an open global panel follows the active YouTube tab and closes from that tab', async () => {
  const f=fixture();
  f.chrome.sidePanel.onOpened.fire({windowId:1});await tick();await f.ready();
  f.tabs.get(11).active=false;
  f.tabs.set(33,{id:33,windowId:1,url:`https://www.youtube.com/watch?v=${OTHER}`,active:true});
  f.chrome.tabs.onActivated.fire({windowId:1,tabId:33});await tick();
  assert.equal((await f.service.handle({action:'getTranscriptPanelState',videoId:OTHER},f.content(33))).open,true);
  await f.service.handle({action:'closeTranscriptPanel',windowId:1,tabId:33,videoId:OTHER},f.panel());
  assert.deepEqual(f.calls.at(-1),{method:'close',options:{windowId:1}});
});

test('a delayed global-panel tab lookup cannot reopen a natively closed panel', async () => {
  const f=fixture();
  f.chrome.sidePanel.onOpened.fire({windowId:1});await tick();await f.ready();
  f.tabs.get(11).active=false;
  f.tabs.set(33,{id:33,windowId:1,url:`https://www.youtube.com/watch?v=${OTHER}`,active:true});
  const gate=deferred(), originalGet=f.chrome.tabs.get;
  f.chrome.tabs.get=async id=>{if(id===33) await gate.promise;return originalGet(id);};
  f.chrome.tabs.onActivated.fire({windowId:1,tabId:33});await tick();
  f.chrome.sidePanel.onClosed.fire({windowId:1});await tick();
  gate.resolve();await tick();
  assert.equal((await f.ready()).open,false);
});
