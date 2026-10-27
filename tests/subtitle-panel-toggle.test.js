const test = require("node:test");
const assert = require("node:assert/strict");
const { createPanelController } = require("../subtitle-overlay.js");

const VIDEO_A = "abcdefghijk";
const VIDEO_B = "lmnopqrstuv";
const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(send = () => ({ success: true, open: true }), options = {}) {
  const calls = [];
  const renders = [];
  const timers = new Map();
  let nextTimer = 0;
  const controller = createPanelController({
    send(message) { calls.push(message); return send(message); },
    render(state) { renders.push(state); },
    timers: {
      setTimeout(callback, duration) {
        assert.ok([3000, 20000].includes(duration));
        const id = ++nextTimer;
        const fire = () => { timers.delete(id); callback(); };
        fire.duration = duration;
        timers.set(id, fire);
        return id;
      },
      clearTimeout(id) { timers.delete(id); },
    }, ...options,
  });
  controller.setVideo(VIDEO_A);
  return { controller, calls, renders, timers };
}
const event = (open, videoId = VIDEO_A) => ({ action: "transcriptPanelState", open, videoId });

test("panel click sends synchronously, alongside fullscreen exit, retaining the user gesture", async () => {
  const order = [];
  const exit = deferred();
  const result = deferred();
  let inClick = true;
  const h = harness((message) => {
    assert.equal(inClick, true);
    order.push("send");
    assert.deepEqual(message, { action: "toggleTranscriptPanel", videoId: VIDEO_A, source: "subtitle", open: true });
    return result.promise;
  }, { exitFullscreen() { order.push("exit"); return exit.promise; } });
  h.controller.toggle();
  inClick = false;
  assert.deepEqual(order, ["exit", "send"]);
  assert.equal(h.controller.snapshot().open, false, "does not optimistically claim the panel opened");
  assert.equal(h.controller.snapshot().pending, true);
  result.resolve({ success: true, open: true });
  exit.resolve();
  await settle();
  assert.equal(h.controller.snapshot().open, true);
  assert.equal(h.controller.snapshot().pending, false);
  assert.equal(h.timers.size, 0);
});

test("rapid clicks send only one request until the panel action completes", async () => {
  const response = deferred();
  const h = harness(() => response.promise);
  h.controller.toggle();
  h.controller.toggle();
  h.controller.toggle();
  assert.equal(h.calls.length, 1);
  response.resolve({ success: true, open: true });
  await settle();
  assert.equal(h.controller.snapshot().pending, false);
});

test("native close before a delayed open response stays closed", async () => {
  const response = deferred();
  const h = harness(() => response.promise);
  h.controller.toggle();
  h.controller.receive(event(true));
  h.controller.receive(event(false));
  response.resolve({ success: true, open: true });
  await settle();
  assert.equal(h.controller.snapshot().open, false);
  assert.equal(h.controller.snapshot().pending, false);
});

test("native close synchronizes both controls without toggling subtitle preference or playback", async () => {
  const h = harness();
  h.controller.toggle();
  await settle();
  h.controller.receive(event(false));
  assert.equal(h.controller.snapshot().open, false);
  assert.deepEqual(h.calls.map((message) => message.action), ["toggleTranscriptPanel"]);
  assert.equal(h.renders.at(-1).open, false);
});

test("closing an already open panel never requests fullscreen or playback changes", async () => {
  let exitCalls = 0;
  const h = harness(() => ({ success: true, open: false }), { exitFullscreen() { exitCalls += 1; } });
  h.controller.receive(event(true));
  h.controller.toggle();
  await settle();
  assert.equal(exitCalls, 0);
  assert.equal(h.controller.snapshot().open, false);
  assert.deepEqual(h.calls, [{ action: "toggleTranscriptPanel", videoId: VIDEO_A, source: "subtitle", open: false }]);
});

test("navigation ignores late toggles and native events belonging to the prior video", async () => {
  const response = deferred();
  const h = harness(() => response.promise);
  h.controller.toggle();
  h.controller.setVideo(VIDEO_B);
  h.controller.receive(event(true));
  response.resolve({ success: true, open: true });
  await settle();
  assert.deepEqual(h.controller.snapshot(), { videoId: VIDEO_B, open: false, pending: false, error: "" });
});

test("the current video's state query restores existing native panel state", async () => {
  const h = harness(() => ({ open: true }));
  h.controller.refresh();
  await settle();
  assert.deepEqual(h.calls, [{ action: "getTranscriptPanelState", videoId: VIDEO_A }]);
  assert.equal(h.controller.snapshot().open, true);
});

test("a delayed query cannot overwrite a newer native close or click", async () => {
  const query = deferred();
  const h = harness((message) => message.action === "getTranscriptPanelState" ? query.promise : { success: true, open: true });
  h.controller.refresh();
  await settle();
  h.controller.receive(event(false));
  query.resolve({ open: true });
  await settle();
  assert.equal(h.controller.snapshot().open, false);
  const nextQuery = deferred();
  const second = harness((message) => message.action === "getTranscriptPanelState" ? nextQuery.promise : { success: true, open: true });
  second.controller.refresh();
  await settle();
  second.controller.toggle();
  await settle();
  nextQuery.resolve({ open: false });
  await settle();
  assert.equal(second.controller.snapshot().open, true);
});

test("API rejection leaves the previous state intact and allows an explicit retry", async () => {
  let attempts = 0;
  const h = harness(() => ++attempts === 1 ? { success: false, error: "Panel unavailable" } : { success: true, open: true });
  h.controller.toggle();
  await settle();
  assert.equal(h.controller.snapshot().open, false);
  assert.match(h.controller.snapshot().error, /Panel unavailable/);
  assert.equal(h.controller.snapshot().pending, false);
  h.controller.toggle();
  await settle();
  assert.equal(h.controller.snapshot().open, true);
  assert.equal(h.controller.snapshot().error, "");
});

test("synchronous send failures restore controls and explain extension reconnection", () => {
  const h = harness(() => { throw new Error("Extension context invalidated."); });
  h.controller.toggle();
  assert.equal(h.controller.snapshot().pending, false);
  assert.match(h.controller.snapshot().error, /刷新视频页面/);
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].duration, 3000);
});

test("an unanswered toggle times out, reconciles state, and ignores its late response", async () => {
  const pending = deferred();
  const query = deferred();
  const h = harness((message) => message.action === "toggleTranscriptPanel" ? pending.promise : query.promise);
  h.controller.toggle();
  [...h.timers.values()][0]();
  assert.equal(h.controller.snapshot().pending, false);
  assert.match(h.controller.snapshot().error, /超时/);
  pending.resolve({ success: true, open: true });
  await settle();
  assert.equal(h.controller.snapshot().open, false);
  query.resolve({ open: true });
  await settle();
  assert.equal(h.controller.snapshot().open, true, "verified native state can recover a timed-out action");
});

test("leaving watch pages and destroying the overlay prevent pending callbacks from rendering an open panel", async () => {
  const response = deferred();
  const h = harness(() => response.promise);
  h.controller.toggle();
  h.controller.setVideo("");
  h.controller.toggle();
  h.controller.refresh();
  h.controller.receive(event(true, ""));
  response.resolve({ success: true, open: true });
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.controller.snapshot().open, false);
  h.controller.destroy();
  assert.equal(h.timers.size, 0);
});

test("failed fullscreen exit still sends the immediate open request and gives an actionable hint", async () => {
  const h = harness(() => ({ success: true, open: true }), {
    exitFullscreen() { return Promise.reject(new Error("fullscreen exit denied")); },
  });
  h.controller.toggle();
  assert.equal(h.calls.length, 1);
  await settle();
  assert.equal(h.controller.snapshot().open, true);
  assert.match(h.controller.snapshot().error, /Esc/);
});

test("hidden tabs skip state queries and becoming visible recovers active-tab state", async () => {
  let visible = false;
  const h = harness(() => ({ open: true }), { isVisible: () => visible });
  h.controller.refresh();
  await settle();
  assert.equal(h.calls.length, 0, "does not report an inactive-tab rejection as a user-facing error");
  visible = true;
  h.controller.refresh();
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.controller.snapshot().open, true);
});

test("a tab reactivation failure stays silent and a later successful query restores state", async () => {
  let attempts = 0;
  const h = harness(() => ++attempts === 1 ? { error: "视频已切换" } : { open: true });
  h.controller.refresh();
  await settle();
  assert.equal(h.controller.snapshot().error, "");
  h.controller.refresh();
  await settle();
  assert.equal(h.controller.snapshot().error, "");
  assert.equal(h.controller.snapshot().open, true);
});

test("passive rejection, malformed replies, synchronous failure and timeout never notify or loop", async () => {
  for (const send of [() => ({ error: "逐字稿请求与当前视频不匹配" }), () => ({}), () => null,
    () => Promise.reject(new Error("offline")), () => { throw new Error("disconnected"); }, () => new Promise(() => {})]) {
    const h = harness(send);
    h.controller.receive(event(true));
    h.controller.refresh();
    await settle();
    for (const timer of [...h.timers.values()]) timer();
    await settle();
    assert.equal(h.controller.snapshot().error, "");
    assert.equal(h.controller.snapshot().open, true);
    assert.equal(h.calls.length, 1);
    assert.equal(h.timers.size, 0);
  }
});

test("manual failure expires after 3000 ms without passive failures or rendering extending it", async () => {
  const h = harness(() => ({ error: "逐字稿请求与当前视频不匹配" }));
  h.controller.toggle();
  await settle();
  assert.match(h.controller.snapshot().error, /不匹配/);
  const timer = [...h.timers.values()].find((value) => value.duration === 3000);
  assert.ok(timer);
  h.controller.snapshot();
  h.controller.refresh();
  await settle();
  assert.ok([...h.timers.values()].includes(timer), "passive failure must not replace the notice timer");
  timer();
  assert.equal(h.controller.snapshot().error, "");
  assert.equal(h.controller.snapshot().pending, false);
  assert.equal(h.controller.snapshot().open, false);
  assert.equal(h.calls.length, 2);
  assert.equal(h.timers.size, 0);
});

test("dismiss is local and a previous timeout cannot hide a retry's new failure", async () => {
  const h = harness(() => ({ error: "Panel failed" }));
  h.controller.toggle();
  await settle();
  const oldTimer = [...h.timers.values()][0];
  h.controller.dismissError();
  assert.equal(h.controller.snapshot().error, "");
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0);
  h.controller.toggle();
  await settle();
  const newTimer = [...h.timers.values()][0];
  assert.equal(newTimer.duration, 3000);
  oldTimer();
  assert.match(h.controller.snapshot().error, /Panel failed/);
  assert.ok([...h.timers.values()].includes(newTimer));
  newTimer();
  assert.equal(h.controller.snapshot().error, "");
});

test("late fullscreen failures cannot resurrect manually or automatically dismissed notices", async () => {
  for (const manual of [true, false]) {
    const exit = deferred();
    const h = harness(() => ({ error: "open failed" }), { exitFullscreen: () => exit.promise });
    h.controller.toggle();
    await settle();
    if (manual) h.controller.dismissError(); else [...h.timers.values()][0]();
    exit.reject(new Error("late exit failure"));
    await settle();
    assert.equal(h.controller.snapshot().error, "");
    assert.equal(h.timers.size, 0);
  }
});

test("a dismissed fullscreen hint stays hidden if the same operation later times out", async () => {
  const h = harness(() => new Promise(() => {}), { exitFullscreen: () => Promise.reject(new Error("exit failed")) });
  h.controller.toggle();
  await settle();
  assert.match(h.controller.snapshot().error, /Esc/);
  [...h.timers.values()].find((value) => value.duration === 3000)();
  [...h.timers.values()].find((value) => value.duration === 20000)();
  await settle();
  assert.equal(h.controller.snapshot().error, "");
  assert.equal(h.controller.snapshot().pending, false);
  h.controller.destroy();
});

test("success, navigation, player rebuild and destruction clear notification timers", async () => {
  for (const clear of [(c) => c.receive(event(true)), (c) => c.setVideo(VIDEO_B),
    (c) => c.resetView(), (c) => c.destroy()]) {
    const h = harness(() => ({ error: "failed" }));
    h.controller.toggle();
    await settle();
    const timer = [...h.timers.values()][0];
    clear(h.controller);
    assert.equal(h.controller.snapshot().error, "");
    assert.equal(h.timers.size, 0);
    timer();
    assert.equal(h.controller.snapshot().error, "");
  }
});

test("rebuilding a player ignores old pending action errors, but permits a new explicit retry", async () => {
  const response = deferred();
  let attempts = 0;
  const h = harness(() => ++attempts === 1 ? response.promise : { error: "new failure" });
  h.controller.toggle();
  h.controller.resetView();
  response.reject(new Error("stale failure"));
  await settle();
  assert.equal(h.controller.snapshot().error, "");
  assert.equal(h.controller.snapshot().pending, false);
  h.controller.toggle();
  await settle();
  assert.match(h.controller.snapshot().error, /new failure/);
  h.controller.destroy();
});
