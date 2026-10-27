const test = require("node:test");
const assert = require("node:assert/strict");
const { watchVideoId, activeSegmentIndex, createController, displayText, suppressNativeCaptions, requestWithTimeout } = require("../subtitle-overlay.js");

const VIDEO_A = "abcdefghijk";
const VIDEO_B = "lmnopqrstuv";
const tickAsync = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function track(videoId = VIDEO_A, translations = {}) {
  return {
    videoId,
    segments: Array.from({ length: 8 }, (_, index) => ({ id: `s${index}`, start: index * 10,
      end: index * 10 + 8, text: `Complete paragraph ${index}. More text in the same paragraph.` })),
    translations,
  };
}
function harness(respond) {
  const calls = [];
  const renders = [];
  const controller = createController({ request(message) {
    calls.push(message);
    return Promise.resolve().then(() => respond(message));
  }, render(state) { renders.push(state); } });
  controller.setVideo(VIDEO_A);
  return { controller, calls, renders, translations: () => calls.filter((call) => call.action === "translateSubtitleSegments") };
}
const translated = (message) => ({ videoId: message.videoId,
  segments: message.segmentIds.map((id) => ({ id, text: `翻译 ${id}` })) });

test("recognizes only supported watch pages and valid video identities", () => {
  assert.equal(watchVideoId(`https://www.youtube.com/watch?v=${VIDEO_A}&t=10`), VIDEO_A);
  for (const url of [`https://www.youtube.com/shorts/${VIDEO_A}`, `https://example.com/watch?v=${VIDEO_A}`,
    "https://www.youtube.com/watch?v=short", "not a url", "https://www.youtube.com/"]) {
    assert.equal(watchVideoId(url), "", url);
  }
});

test("display removes known no-attribute formatting without interpreting other markup", () => {
  assert.equal(displayText("<i>Hello <b>world</b></i>"), "Hello world");
  assert.equal(displayText('<img src="x" onerror="alert(1)"> and <i class="x">quoted</i>'),
    '<img src="x" onerror="alert(1)"> and <i class="x">quoted');
  assert.equal(displayText("C++ uses <vector>; a < b."), "C++ uses <vector>; a < b.");
});

test("a failed translation still suppresses native captions when its original remains visible", () => {
  assert.equal(suppressNativeCaptions({ enabled: true, segment: { text: "original" }, error: "failed" }), true);
  assert.equal(suppressNativeCaptions({ enabled: true, segment: null, error: "track failed" }), false);
  assert.equal(suppressNativeCaptions({ enabled: true, segment: null, error: "" }), true, "music-only gaps must not expose native sound labels");
  assert.equal(suppressNativeCaptions({ enabled: false, segment: { text: "original" } }), false);
  assert.equal(suppressNativeCaptions({ enabled: true, advertising: true, segment: { text: "original" } }), false);
});

test("unanswered extension messages time out and ignore a late success", async () => {
  let fire;
  let cleared = false;
  const timers = { setTimeout(callback, delay) { assert.equal(delay, 130000); fire = callback; return 1; },
    clearTimeout(id) { assert.equal(id, 1); cleared = true; } };
  const response = deferred();
  const request = requestWithTimeout(() => response.promise, { action: "test" }, timers);
  fire();
  await assert.rejects(request, /中断或超时/);
  response.resolve({ enabled: true });
  await tickAsync();
  assert.equal(cleared, true);
  await assert.rejects(request, /中断或超时/);
});

test("settled extension messages clear the watchdog timer", async () => {
  let cleared = 0;
  const timers = { setTimeout() { return 17; }, clearTimeout(id) { assert.equal(id, 17); cleared += 1; } };
  assert.deepEqual(await requestWithTimeout(() => ({ enabled: true }), {}, timers), { enabled: true });
  await assert.rejects(requestWithTimeout(() => Promise.reject(new Error("offline")), {}, timers), /offline/);
  assert.equal(cleared, 2);
});

test("matches fractional timestamps and clears gaps, before-first, and ended subtitles", () => {
  const segments = [{ id: "a", start: 1.25, end: 2.75 }, { id: "b", start: 4.1, end: 5.2 }];
  assert.equal(activeSegmentIndex(segments, 1.249), -1);
  assert.equal(activeSegmentIndex(segments, 1.25), 0);
  assert.equal(activeSegmentIndex(segments, 2.75), -1);
  assert.equal(activeSegmentIndex(segments, 3.9), -1);
  assert.equal(activeSegmentIndex(segments, 4.101), 1);
  assert.equal(activeSegmentIndex(segments, 5.2), -1);
  assert.equal(activeSegmentIndex(segments, NaN), -1);
  assert.equal(activeSegmentIndex([], 0), -1);
});

test("defaults off and makes no paid or transcript request until explicitly enabled", async () => {
  const h = harness(() => { throw new Error("Unexpected request"); });
  h.controller.tick(12, false);
  await tickAsync();
  assert.equal(h.controller.snapshot().enabled, false);
  assert.equal(h.calls.length, 0);
});

test("uses cached translations immediately without requesting them again", async () => {
  const h = harness(() => track(VIDEO_A, { s0: "已有翻译" }));
  h.controller.setEnabled(true);
  await tickAsync();
  assert.equal(h.controller.snapshot().translation, "已有翻译");
  assert.equal(h.translations().length, 0);
  assert.equal(h.controller.snapshot().segment.text, track().segments[0].text);
});

test("requests the current paragraph first, then only the following three while playing", async () => {
  const current = deferred();
  const h = harness((message) => message.action === "getSubtitleTrack" ? track()
    : message.segmentIds[0] === "s0" ? current.promise : translated(message));
  h.controller.setEnabled(true);
  h.controller.tick(0, false);
  await tickAsync();
  assert.deepEqual(h.translations().map((call) => call.segmentIds), [["s0"]]);
  assert.equal(h.controller.snapshot().translation, "");
  current.resolve({ videoId: VIDEO_A, segments: [{ id: "s0", text: "当前翻译" }] });
  await tickAsync();
  assert.deepEqual(h.translations().map((call) => call.segmentIds), [["s0"], ["s1", "s2", "s3"]]);
  assert.equal(h.controller.snapshot().translation, "当前翻译");
  await tickAsync();
  assert.equal(h.translations().length, 2, "does not translate the entire video");
});

test("repeated time updates deduplicate the same outstanding paragraph", async () => {
  const translation = deferred();
  const h = harness((message) => message.action === "getSubtitleTrack" ? track() : translation.promise);
  h.controller.setEnabled(true);
  await tickAsync();
  for (let time = 0; time < 7; time += 0.2) h.controller.tick(time, false);
  assert.equal(h.translations().length, 1);
  h.controller.setEnabled(false);
  translation.resolve({ videoId: VIDEO_A, segments: [{ id: "s0", text: "旧结果" }] });
  await tickAsync();
  assert.equal(h.controller.snapshot().enabled, false);
  assert.equal(h.controller.snapshot().translation, "");
  assert.equal(h.translations().length, 1);
});

test("pausing during current translation prevents subsequent prefetch", async () => {
  const current = deferred();
  const h = harness((message) => message.action === "getSubtitleTrack" ? track() : current.promise);
  h.controller.setEnabled(true);
  h.controller.tick(0, false);
  await tickAsync();
  h.controller.tick(0, true);
  current.resolve({ videoId: VIDEO_A, segments: [{ id: "s0", text: "暂停显示" }] });
  await tickAsync();
  assert.equal(h.translations().length, 1);
  assert.equal(h.controller.snapshot().translation, "暂停显示");
});

test("seeking prioritizes the new current paragraph and never renders a late old translation", async () => {
  const first = deferred();
  const h = harness((message) => message.action === "getSubtitleTrack" ? track()
    : message.segmentIds[0] === "s0" ? first.promise : translated(message));
  h.controller.setEnabled(true);
  await tickAsync();
  h.controller.tick(60.5, true);
  await tickAsync();
  assert.deepEqual(h.translations().map((call) => call.segmentIds), [["s0"], ["s6"]]);
  assert.equal(h.controller.snapshot().segment.id, "s6");
  first.resolve({ videoId: VIDEO_A, segments: [{ id: "s0", text: "过时位置" }] });
  await tickAsync();
  assert.equal(h.controller.snapshot().translation, "翻译 s6");
});

test("navigation discards old track responses even when they arrive after the new video", async () => {
  const oldTrack = deferred();
  const h = harness((message) => message.videoId === VIDEO_A ? oldTrack.promise : track(VIDEO_B, { s0: "新视频" }));
  h.controller.setEnabled(true);
  h.controller.setVideo(VIDEO_B);
  await tickAsync();
  oldTrack.resolve(track(VIDEO_A, { s0: "旧视频" }));
  await tickAsync();
  assert.equal(h.controller.snapshot().videoId, VIDEO_B);
  assert.equal(h.controller.snapshot().translation, "新视频");
});

test("old video translations do not populate the new video's display", async () => {
  const oldTranslation = deferred();
  const h = harness((message) => message.action === "getSubtitleTrack"
    ? track(message.videoId, message.videoId === VIDEO_B ? { s0: "新视频译文" } : {}) : oldTranslation.promise);
  h.controller.setEnabled(true);
  await tickAsync();
  h.controller.setVideo(VIDEO_B);
  await tickAsync();
  oldTranslation.resolve({ videoId: VIDEO_A, segments: [{ id: "s0", text: "旧视频译文" }] });
  await tickAsync();
  assert.equal(h.controller.snapshot().translation, "新视频译文");
});

test("translation failures stop automatic retries and an explicit retry propagates retry:true", async () => {
  const h = harness((message) => message.action === "getSubtitleTrack" ? track()
    : message.retry ? translated(message) : { error: "API key missing" });
  h.controller.setEnabled(true);
  await tickAsync();
  for (let i = 0; i < 10; i++) h.controller.tick(1, true);
  await tickAsync();
  assert.equal(h.translations().length, 1);
  assert.match(h.controller.snapshot().error, /API key missing/);
  h.controller.retry();
  await tickAsync();
  assert.equal(h.translations()[1].retry, true);
  assert.equal(h.controller.snapshot().translation, "翻译 s0");
  assert.equal(h.controller.snapshot().error, "");
});

test("track failures retry explicitly and report a readable service-worker interruption", async () => {
  const h = harness((message) => {
    if (!message.retry) throw new Error("The message port closed before a response was received");
    return track(VIDEO_A, { s0: "恢复的缓存" });
  });
  h.controller.setEnabled(true);
  await tickAsync();
  assert.match(h.controller.snapshot().error, /扩展连接已中断/);
  h.controller.tick(1, false);
  assert.equal(h.calls.length, 1);
  h.controller.tick(1, true);
  h.controller.retry();
  await tickAsync();
  assert.equal(h.calls[1].retry, true);
  assert.equal(h.controller.snapshot().translation, "恢复的缓存");
});

test("a top-level service failure stays stopped after playback advances to new paragraphs", async () => {
  const h = harness((message) => message.action === "getSubtitleTrack" ? track()
    : message.retry ? translated(message) : { error: "Service unavailable" });
  h.controller.setEnabled(true);
  await tickAsync();
  h.controller.tick(10.5, true);
  h.controller.tick(20.5, true);
  await tickAsync();
  assert.equal(h.translations().length, 1);
  assert.match(h.controller.snapshot().error, /Service unavailable/);
  h.controller.retry();
  await tickAsync();
  assert.deepEqual(h.translations()[1].segmentIds, ["s2"]);
  assert.equal(h.translations()[1].retry, true);
  assert.equal(h.controller.snapshot().translation, "翻译 s2");
});

test("a service failure returned as all failed segments also latches until explicit retry", async () => {
  const h = harness((message) => message.action === "getSubtitleTrack" ? track(VIDEO_A, { s0: "缓存可读" })
    : message.retry ? translated(message) : { videoId: VIDEO_A,
      segments: message.segmentIds.map((id) => ({ id, text: "", error: "Missing API key" })) });
  h.controller.setEnabled(true);
  h.controller.tick(0, false);
  await tickAsync();
  assert.equal(h.controller.snapshot().translation, "缓存可读");
  assert.equal(h.controller.snapshot().error, "", "cached paragraphs stay readable without an unrelated error");
  h.controller.tick(40, true);
  await tickAsync();
  assert.equal(h.translations().length, 1);
  assert.match(h.controller.snapshot().error, /Missing API key/);
  h.controller.retry();
  await tickAsync();
  assert.deepEqual(h.translations()[1].segmentIds, ["s4"]);
  assert.equal(h.translations()[1].retry, true);
  assert.equal(h.controller.snapshot().translation, "翻译 s4");
});

test("per-segment errors and empty model output never count as successful translations", async () => {
  const h = harness((message) => message.action === "getSubtitleTrack" ? track(VIDEO_A, { s0: "已缓存" })
    : { videoId: VIDEO_A, segments: [{ id: "s1", text: "正确" }, { id: "s2", error: "段落失败" }, { id: "s3", text: "  " }] });
  h.controller.setEnabled(true);
  h.controller.tick(0, false);
  await tickAsync();
  h.controller.tick(20, true);
  assert.match(h.controller.snapshot().error, /段落失败/);
  h.controller.tick(30, true);
  assert.match(h.controller.snapshot().error, /未能翻译/);
  assert.equal(h.translations().length, 1);
});

test("ads hide content and stop new translation requests until normal playback returns", async () => {
  const h = harness((message) => message.action === "getSubtitleTrack" ? track() : translated(message));
  h.controller.tick(0, false, true);
  h.controller.setEnabled(true);
  await tickAsync();
  assert.equal(h.controller.snapshot().advertising, true);
  assert.equal(h.translations().length, 0);
  h.controller.tick(0, true, false);
  await tickAsync();
  assert.equal(h.translations().length, 1);
});

test("empty subtitle tracks display the empty state and never call translation", async () => {
  const h = harness(() => ({ videoId: VIDEO_A, segments: [], translations: {} }));
  h.controller.setEnabled(true);
  await tickAsync();
  assert.equal(h.controller.snapshot().empty, true);
  assert.equal(h.translations().length, 0);
});

test("turning off and back on reloads shared cached data and preserves fractional playhead", async () => {
  const h = harness((message) => message.action === "getSubtitleTrack" ? track(VIDEO_A, { s1: "缓存段落一" }) : translated(message));
  h.controller.tick(10.75, true);
  h.controller.setEnabled(true);
  await tickAsync();
  h.controller.setEnabled(false);
  h.controller.setEnabled(true);
  await tickAsync();
  assert.equal(h.controller.snapshot().segment.id, "s1");
  assert.equal(h.controller.snapshot().translation, "缓存段落一");
  assert.equal(h.calls.filter((call) => call.action === "getSubtitleTrack").length, 2);
});

test("changing source drops late English translation and keeps the same paused playhead", async () => {
  let language = "en";
  const oldTranslation = deferred();
  const h = harness((message) => {
    if (message.action === "getSubtitleTrack") return { ...track(), trackKey: language,
      segments: [{ id: "s0", start: 0, end: 100, text: language === "ko" ? "카메라를 다시 켤까요?" : "Should I restart it?" }],
      translations: language === "ko" ? { s0: "我要重启一下吗？" } : {} };
    assert.equal(message.trackKey, "en");
    return oldTranslation.promise;
  });
  h.controller.tick(42, true);
  h.controller.setEnabled(true);
  await tickAsync();
  language = "ko";
  h.controller.reloadSource();
  await tickAsync();
  assert.equal(h.controller.snapshot().segment.text, "카메라를 다시 켤까요?");
  assert.equal(h.controller.snapshot().translation, "我要重启一下吗？");
  oldTranslation.resolve({ videoId: VIDEO_A, trackKey: "en", segments: [{ id: "s0", text: "旧英文结果" }] });
  await tickAsync();
  assert.equal(h.controller.snapshot().translation, "我要重启一下吗？");
  assert.equal(h.controller.snapshot().paused, true);
  assert.equal(h.translations().length, 1);
});

test("another surface changing an automatic track triggers one bounded reload", async () => {
  let loads = 0;
  const h = harness(message => {
    if (message.action === "getSubtitleTrack") {
      loads += 1;
      return { ...track(), trackKey: loads === 1 ? "en" : "ko" };
    }
    if (message.trackKey === "en") return { error: "SUBTITLE_TRACK_CHANGED", message: "字幕语言已切换" };
    return translated(message);
  });
  h.controller.setEnabled(true);
  await tickAsync(); await tickAsync();
  assert.equal(loads, 2);
  assert.equal(h.controller.snapshot().translation, "翻译 s0");
  assert.equal(h.controller.snapshot().error, "");
  const failure = harness(message => message.action === "getSubtitleTrack" ? track() : { error: "SUBTITLE_TRACK_CHANGED" });
  failure.controller.setEnabled(true);
  await tickAsync(); await tickAsync();
  assert.equal(failure.calls.filter(m => m.action === "getSubtitleTrack").length, 2);
  assert.ok(failure.controller.snapshot().error);
});
