const test = require("node:test");
const assert = require("node:assert/strict");
const { install, contextMenuPosition } = require("../subtitle-overlay.js");

const settle = () => new Promise((resolve) => setImmediate(resolve));

// Exercise the real installed event handlers with only the DOM/browser surface
// they need; no network, playback methods, or translation calls are available.
function harness(respond) {
  const calls = [];
  const eventListeners = new WeakMap();
  class Node {
    constructor(name = "div") {
      this.name = name; this.children = []; this.hidden = false; this.attributes = {};
      this.className = ""; this.style = { setProperty() {} }; this.isConnected = true;
      this.classList = {
        contains: (value) => this.className.split(" ").includes(value),
        toggle: (value, on) => { this.className = this.className.split(" ").filter((name) => name !== value).concat(on ? [value] : []).join(" "); },
      };
      eventListeners.set(this, new Map());
    }
    append(...nodes) { for (const child of nodes) { this.children.push(child); child.parent = this; } }
    appendChild(node) { this.append(node); return node; }
    remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    getBoundingClientRect() {
      return this.className === "context-menu" ? { left: 0, top: 0, width: 190, height: 84 }
        : { left: 20, top: 50, width: 800, height: 450, bottom: 500 };
    }
    addEventListener(name, handler, capture) {
      const list = eventListeners.get(this).get(name) || [];
      list.push({ handler, capture }); eventListeners.get(this).set(name, list);
    }
    removeEventListener(name, handler) {
      const map = eventListeners.get(this); map.set(name, (map.get(name) || []).filter((item) => item.handler !== handler));
    }
    attachShadow() { const shadow = new Node("shadow"); shadow.host = this; this.shadow = shadow; return shadow; }
    querySelector(selector) { return this === player && selector.includes("video") ? video : null; }
    focus() { doc.activeElement = this; this.focused = true; }
  }
  const player = new Node("player");
  const video = new Node("video");
  Object.assign(video, { currentTime: 14, paused: true, ended: false, playbackRate: 1.25 });
  player.append(video);
  const doc = new Node("document");
  Object.assign(doc, { visibilityState: "visible", documentElement: new Node("html"), activeElement: video,
    createElement: (tag) => new Node(tag), createElementNS: (_, tag) => new Node(tag),
    querySelector: () => player, exitFullscreen() { calls.push({ action: "exitFullscreen" }); return Promise.resolve(); },
  });
  const win = new Node("window");
  let timerId = 0;
  const timers = new Map();
  Object.assign(win, { innerWidth: 1000, innerHeight: 700,
    location: { href: "https://www.youtube.com/watch?v=abcdefghijk" },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout(fn, delay) { const id = ++timerId; fn.delay = delay; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
  });
  let receiver;
  const chrome = { runtime: {
    onMessage: { addListener(fn) { receiver = fn; }, removeListener() {} },
    sendMessage(message) {
      calls.push(message);
      if (respond) { const result = respond(message); if (result !== undefined) return result; }
      if (message.action === "getSubtitleSourceLanguage") return Promise.resolve({ preference: "auto", language: "en", reason: "fallback", availableLanguages: ["en", "ja", "ko"] });
      if (message.action === "getSubtitlePreference") return Promise.resolve({ enabled: false });
      if (message.action === "getTranscriptPanelState") return Promise.resolve({ open: false });
      if (message.action === "toggleTranscriptPanel") return Promise.resolve({ success: true, open: message.open });
      throw new Error(`Unexpected action ${message.action}`);
    },
  } };
  const instance = install(win, doc, chrome);
  const host = player.children.find((node) => node.id === "ytd-subtitle-overlay");
  function find(name, node = host.shadow) {
    if (node.className === name) return node;
    for (const child of node.children) { const match = find(name, child); if (match) return match; }
    return null;
  }
  const menu = find("context-menu"), item = find("context-menu-item");
  function fire(target, name, props = {}) {
    const path = props.path || [video, player, doc];
    const event = { button: 0, clientX: 600, clientY: 400, ...props,
      prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.stopped = true; }, composedPath: () => path,
    };
    for (const { handler } of eventListeners.get(target).get(name) || []) handler(event);
    return event;
  }
  return { win, doc, player, video, host, menu, item, find, calls, fire, instance, timers,
    receive: (message) => receiver(message), listeners: (target, name) => eventListeners.get(target).get(name) || [] };
}

test("normal video and captions have no transcript entry button or reserved toolbar", async () => {
  const h = harness();
  await settle();
  assert.equal(h.menu.hidden, true);
  assert.equal(h.find("panel-entry"), null);
  assert.equal(h.find("caption-toolbar"), null);
  assert.equal(h.find("caption-panel-button"), null);
  assert.deepEqual(h.find("captions").children.map((node) => node.className), ["original", "translation", "status", "actions"]);
  h.instance.destroy();
});

test("right-click only shows the menu; a left-click on its item opens synchronously", async () => {
  const h = harness();
  await settle();
  h.doc.fullscreenElement = h.player;
  const rightClick = h.fire(h.doc, "contextmenu", { button: 2 });
  assert.equal(rightClick.prevented, true);
  assert.equal(rightClick.stopped, true);
  assert.equal(h.menu.hidden, false);
  assert.equal(h.item.attributes["aria-label"], "打开逐字稿");
  assert.equal(h.calls.filter((call) => call.action === "toggleTranscriptPanel").length, 0);
  h.fire(h.item, "click", { button: 2 });
  assert.equal(h.calls.filter((call) => call.action === "toggleTranscriptPanel").length, 0);
  const before = h.calls.length;
  const click = h.fire(h.item, "click");
  assert.equal(click.prevented, true);
  assert.equal(click.stopped, true);
  assert.equal(h.menu.hidden, true);
  assert.deepEqual(h.calls.slice(before).map((call) => call.action), ["exitFullscreen", "toggleTranscriptPanel"]);
  assert.deepEqual([h.video.currentTime, h.video.paused, h.video.playbackRate], [14, true, 1.25]);
  await settle();
  h.fire(h.doc, "contextmenu", { button: 2 });
  assert.equal(h.item.attributes["aria-label"], "收起逐字稿");
  h.instance.destroy();
});

test("Shift right-click preserves YouTube's menu and right-click outside the video is untouched", async () => {
  const h = harness(); await settle();
  h.fire(h.doc, "contextmenu", { button: 2 });
  const original = h.fire(h.doc, "contextmenu", { button: 2, shiftKey: true });
  assert.equal(h.menu.hidden, true);
  assert.equal(original.prevented, false);
  assert.equal(original.stopped, false);
  const outside = h.fire(h.doc, "contextmenu", { button: 2, path: [h.doc] });
  assert.equal(outside.prevented, false);
  assert.equal(h.menu.hidden, true);
  h.instance.destroy();
});

test("outside click, Escape, focus loss, blur, and navigation dismiss without opening or pausing", async () => {
  const h = harness(); await settle();
  for (const dismiss of [
    () => h.fire(h.doc, "pointerdown"),
    () => h.fire(h.doc, "keydown", { key: "Escape" }),
    () => h.fire(h.doc, "focusin", { path: [h.doc] }),
    () => h.fire(h.win, "blur"),
  ]) {
    h.fire(h.doc, "contextmenu", { button: 2 });
    assert.equal(h.menu.hidden, false);
    dismiss();
    assert.equal(h.menu.hidden, true);
  }
  h.fire(h.doc, "contextmenu", { button: 2 });
  h.fire(h.doc, "yt-navigate-start");
  assert.equal(h.host.isConnected, false);
  assert.equal(h.listeners(h.doc, "contextmenu").length, 0);
  assert.equal(h.calls.filter((call) => call.action === "toggleTranscriptPanel").length, 0);
  assert.deepEqual([h.video.currentTime, h.video.paused, h.video.playbackRate], [14, true, 1.25]);
  h.instance.destroy();
});

test("menu item pointer events retain the menu while hint clicks and double-clicks cannot reach playback", async () => {
  const h = harness(); await settle();
  h.fire(h.doc, "contextmenu", { button: 2 });
  h.fire(h.doc, "pointerdown", { path: [h.item, h.menu, h.host, h.player, h.doc] });
  assert.equal(h.menu.hidden, false);
  for (const name of ["click", "dblclick", "auxclick"]) {
    const event = h.fire(h.menu, name);
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
  }
  h.receive({ action: "transcriptPanelState", videoId: "abcdefghijk", open: true });
  assert.equal(h.item.attributes["aria-label"], "收起逐字稿");
  h.receive({ action: "transcriptPanelState", videoId: "abcdefghijk", open: false });
  assert.equal(h.item.attributes["aria-label"], "打开逐字稿");
  h.instance.destroy();
});

test("context menu remains inside normal, narrow, full-screen and partially clipped players", () => {
  const menu = { width: 190, height: 84 };
  const viewport = { width: 1280, height: 720 };
  for (const player of [
    { left: 20, top: 80, width: 800, height: 450 },
    { left: 8, top: 40, width: 344, height: 193 },
    { left: 0, top: 0, width: 1280, height: 720 },
    { left: 20, top: 400, width: 800, height: 450 },
  ]) {
    const result = contextMenuPosition(player, menu,
      { x: player.left + player.width - 1, y: Math.min(719, player.top + player.height - 1) }, viewport);
    assert.ok(result.left >= 8 && result.top >= 8);
    assert.ok(result.left + menu.width <= player.width - 8);
    assert.ok(player.top + result.top + menu.height <= viewport.height - 8);
    assert.ok(result.top + menu.height <= player.height - 8);
  }
});


test("language menu keeps native selection usable and a slow change survives menu reopening", async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const h = harness(message => message.action === "setSubtitleSourceLanguage" ? pending : undefined);
  await settle();
  h.fire(h.doc, "contextmenu", { button: 2 });
  await settle();
  const control = h.find("source-control");
  const select = control.children[0];
  assert.match(h.find("source-status").textContent, /原声未确定/);
  const keys = h.fire(h.doc, "keydown", { key: "ArrowDown", path: [select, control, h.menu, h.player] });
  assert.equal(keys.prevented, false);
  assert.equal(keys.stopped, true);
  select.value = "ko";
  h.fire(select, "change", { target: select });
  assert.equal(select.disabled, true);
  h.fire(h.doc, "keydown", { key: "Escape" });
  h.fire(h.doc, "contextmenu", { button: 2 });
  finish({ preference: "ko", language: "ko", reason: "manual", availableLanguages: ["ko"] });
  await settle();
  assert.equal(select.disabled, false);
  assert.equal(select.value, "ko");
  assert.match(h.find("source-status").textContent, /韩语/);
  assert.deepEqual([h.video.currentTime, h.video.paused, h.video.playbackRate], [14, true, 1.25]);
  assert.equal(h.calls.filter(call => call.action === "setSubtitleSourceLanguage").length, 1);
  h.instance.destroy();
});


test("pointer-focused subtitle controls still hide after their inactivity timer", async () => {
  const h = harness(); await settle();
  h.host.shadow.activeElement = h.find("toggle");
  h.fire(h.player, "mousemove");
  assert.equal(Object.hasOwn(h.host.attributes, "controls-visible"), true);
  [...h.timers.values()].find(timer => timer.delay === 2500)();
  assert.equal(Object.hasOwn(h.host.attributes, "controls-visible"), false);
  h.instance.destroy();
});

test("a late language lookup cannot overwrite a newer source selection broadcast", async () => {
  let finish;
  const lookup = new Promise(resolve => { finish = resolve; });
  const h = harness(message => message.action === "getSubtitleSourceLanguage" ? lookup : undefined);
  await settle();
  h.fire(h.doc, "contextmenu", { button: 2 });
  await settle();
  h.receive({ action: "subtitleSourceChanged", videoId: "abcdefghijk", sourceLanguage: {
    preference: "ko", language: "ko", reason: "manual",
  } });
  finish({ preference: "auto", language: "en", reason: "fallback" });
  await settle();
  assert.equal(h.find("source-control").children[0].value, "ko");
  assert.match(h.find("source-status").textContent, /韩语/);
  h.instance.destroy();
});
