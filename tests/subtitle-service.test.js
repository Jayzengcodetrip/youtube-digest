const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const serviceFactory = require("../subtitle-service.js");
const segments = require("../transcript-segments.js");
const cleanup = require("../transcript-cleanup.js");
const VIDEO = "abcdefghijk";
const OTHER = "lmnopqrstuv";
const NOW = 1_800_000_000_000;
const transcript = [
  { start: 0, duration: 4, text: "This first complete sentence contains enough words to form a whole subtitle paragraph." },
  { start: 4, duration: 4, text: "The second sentence tells us something different and forms another complete paragraph." },
  { start: 8, duration: 4, text: "The final sentence completes the explanation with another useful point for the audience." },
];
const track = segments.buildPlaybackSegments(transcript);
const ids = track.map((segment) => segment.id);
const captionResponse = () => ({ success: true, transcript, language: "en" });
const translationResponse = (rows) => ({ success: true, translatedContent: { segments: rows.map(({ id }) => ({ id, text: `这是字幕的中文翻译。${id}` })) } });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(initial = {}, overrides = {}) {
  const data = structuredClone(initial);
  const storage = {
    async get(key) {
      if (key === null) return structuredClone(data);
      return { [key]: structuredClone(data[key]) };
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  };
  let fetchCount = 0;
  const translatedBatches = [];
  const dependencies = {
    storage, segments, cleanup, now: () => NOW,
    fetchTranscript: async () => { fetchCount++; return captionResponse(); },
    translate: async (rows) => { translatedBatches.push(rows); return translationResponse(rows); },
    ...overrides,
  };
  return { data, storage, dependencies, service: serviceFactory.create(dependencies), translatedBatches, get fetchCount() { return fetchCount; } };
}
function cached(patch = {}) {
  return { timestamp: NOW, transcript, transcriptCleanupVersion: cleanup.VERSION, paragraphCache: {}, interfaceCache: {}, ...patch };
}

test("subtitles default off; the independent preference survives service restart", async () => {
  const f = fixture();
  assert.deepEqual(await f.service.getPreference(), { enabled: false });
  await f.service.setPreference(true);
  const restarted = serviceFactory.create(f.dependencies);
  assert.deepEqual(await restarted.getPreference(), { enabled: true });
  await assert.rejects(() => restarted.setPreference("true"), /boolean/);
  assert.equal(f.fetchCount, 0);
});

test("concurrent panel and player transcript requests share a single fetch and return clean tracks only", async () => {
  const pending = deferred();
  let count = 0;
  const f = fixture({}, { fetchTranscript: async () => { count++; return pending.promise; } });
  const panel = f.service.getTranscript(VIDEO);
  const player = f.service.getTrack(VIDEO);
  await tick();
  assert.equal(count, 1);
  pending.resolve(captionResponse());
  assert.equal((await panel).transcript.length, 3);
  const result = await player;
  assert.deepEqual(result.segments, track);
  assert.deepEqual(Object.keys(result), ["videoId", "segments", "translations", "trackKey", "sourceLanguage"]);
  assert.equal(f.data[`subtitleJobs_${VIDEO}`], undefined);
  await f.service.getTrack(VIDEO);
  assert.equal(count, 1);
});

test("existing 1.2.2 translations are reused; legacy identities and sound cues are discarded", async () => {
  const key = segments.cacheKey(track[0], VIDEO);
  const f = fixture({ [`digest_${VIDEO}`]: cached({
    transcriptCleanupVersion: 0,
    paragraphCache: { [key]: "[音乐]可复用的中文翻译。", [`${VIDEO}:zh:semantic:${ids[1]}`]: "旧译文" },
    analysis: { summary: "Saved overview" },
    secretExample: "must not appear on player",
  }) });
  const result = await f.service.getTrack(VIDEO);
  assert.equal(result.translations[ids[0]], "可复用的中文翻译。");
  assert.equal(result.translations[ids[1]], undefined);
  assert.equal(JSON.stringify(result).includes("secretExample"), false);
  assert.equal(f.fetchCount, 0);
  const translation = await f.service.translateSegments(VIDEO, [ids[0]]);
  assert.equal(translation.segments[0].text, "可复用的中文翻译。");
  assert.equal(f.translatedBatches.length, 0);
});

test("overlapping panel/player translation batches pay for each canonical segment once", async () => {
  const gate = deferred();
  const calls = [];
  const f = fixture({ [`digest_${VIDEO}`]: cached() }, {
    translate: async (rows) => { calls.push(rows); await gate.promise; return translationResponse(rows); },
  });
  const panel = f.service.translateSegments(VIDEO, [ids[0], ids[1]]);
  const player = f.service.translateSegments(VIDEO, [ids[1], ids[2]]);
  await tick();
  assert.deepEqual(calls.flat().map((row) => row.id).sort(), [...ids].sort());
  assert.deepEqual(calls.flat().map((row) => row.text).sort(), track.map((row) => row.text).sort());
  gate.resolve();
  const [first, second] = await Promise.all([panel, player]);
  assert.equal(first.segments[1].text, second.segments[0].text);
  assert.equal(Object.keys(f.data[`digest_${VIDEO}`].paragraphCache).length, 3);
  assert.deepEqual(f.data[`digest_${VIDEO}`].subtitlePending, {});
});

test("a cache read racing translation completion never schedules the same paid segment twice", async () => {
  const providerGate = deferred();
  const staleReadGate = deferred();
  const readStarted = deferred();
  let calls = 0;
  const f = fixture({ [`digest_${VIDEO}`]: cached() }, {
    translate: async (rows) => { calls++; await providerGate.promise; return translationResponse(rows); },
  });
  const first = f.service.translateSegments(VIDEO, [ids[0]]);
  await tick();
  const originalGet = f.storage.get;
  let digestReads = 0;
  f.storage.get = async (key) => {
    const snapshot = await originalGet(key);
    if (key === `digest_${VIDEO}` && ++digestReads === 2) {
      readStarted.resolve();
      await staleReadGate.promise;
    }
    return snapshot;
  };
  const second = f.service.translateSegments(VIDEO, [ids[0]]);
  await readStarted.promise;
  providerGate.resolve();
  await tick();
  staleReadGate.resolve();
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(results[0].segments[0].text, results[1].segments[0].text);
  await f.service.translateSegments(VIDEO, [ids[0]]);
  assert.equal(calls, 1);
});

test("panel saves merge with translations and cannot erase overview, title, or interface translations", async () => {
  const key = segments.cacheKey(track[0], VIDEO);
  const gate = deferred();
  const f = fixture({ [`digest_${VIDEO}`]: cached({ analysis: { overview: "existing" }, videoTitle: "Video title", interfaceCache: { title: "旧标题" } }) }, {
    translate: async (rows) => { await gate.promise; return translationResponse(rows); },
  });
  const translation = f.service.translateSegments(VIDEO, [ids[0]]);
  await tick();
  const save = f.service.saveDigestCache(VIDEO, { analysis: null, videoTitle: "", paragraphCache: {}, interfaceCache: { summary: "新摘要" }, subtitlePending: { injected: 1 } });
  gate.resolve();
  await Promise.all([save, translation]);
  await f.service.saveDigestCache(VIDEO, { paragraphCache: {} });
  const result = f.data[`digest_${VIDEO}`];
  assert.ok(result.paragraphCache[key]);
  assert.deepEqual(result.analysis, { overview: "existing" });
  assert.equal(result.videoTitle, "Video title");
  assert.deepEqual(result.interfaceCache, { title: "旧标题", summary: "新摘要" });
  assert.equal(result.subtitlePending.injected, undefined);
});

test("partial translation failures persist without automatic rebilling until explicit retry", async () => {
  let calls = 0;
  const f = fixture({ [`digest_${VIDEO}`]: cached() }, {
    translate: async (rows) => {
      calls++;
      return { success: true, translatedContent: { segments: rows.map((row, i) => ({ id: row.id, text: calls === 1 && i === 1 ? "" : "有效译文", error: "Provider omitted the row" })) } };
    },
  });
  const first = await f.service.translateSegments(VIDEO, ids.slice(0, 2));
  assert.equal(first.segments[0].text, "有效译文");
  assert.match(first.segments[1].error, /omitted/);
  const restarted = serviceFactory.create(f.dependencies);
  await restarted.translateSegments(VIDEO, ids.slice(0, 2));
  assert.equal(calls, 1);
  const retry = await restarted.translateSegments(VIDEO, [ids[1]], { retry: true });
  assert.equal(calls, 2);
  assert.equal(retry.segments[0].text, "有效译文");
});

test("worker restart reports interrupted translations and needs retry before a new provider request", async () => {
  const key = segments.cacheKey(track[0], VIDEO);
  const f = fixture({ [`digest_${VIDEO}`]: cached({ subtitlePending: { [key]: NOW - 2000 } }) });
  const result = await f.service.translateSegments(VIDEO, [ids[0]]);
  assert.match(result.segments[0].error, /中断/);
  assert.equal(f.translatedBatches.length, 0);
  await f.service.translateSegments(VIDEO, [ids[0]], { retry: true });
  assert.equal(f.translatedBatches.length, 1);
});

test("failed and interrupted transcript fetches need explicit retry; expired failure markers may recover", async () => {
  let calls = 0;
  const f = fixture({}, { fetchTranscript: async () => {
    calls++;
    return calls === 1 ? { success: false, error: "NO_TRANSCRIPT", message: "No native captions" } : captionResponse();
  } });
  await assert.rejects(f.service.getTrack(VIDEO), /No native captions/);
  const restarted = serviceFactory.create(f.dependencies);
  await assert.rejects(restarted.getTrack(VIDEO), /No native captions/);
  assert.equal(calls, 1);
  await restarted.getTrack(VIDEO, { retry: true });
  assert.equal(calls, 2);
  const interrupted = fixture({ [`subtitleJobs_${OTHER}`]: { pending: true, timestamp: NOW } });
  await assert.rejects(interrupted.service.getTrack(OTHER), /中断/);
  assert.equal(interrupted.fetchCount, 0);
  const expired = fixture({ [`subtitleJobs_${OTHER}`]: { pending: true, timestamp: NOW - 31 * 86400000 } });
  await expired.service.getTrack(OTHER);
  assert.equal(expired.fetchCount, 1);
});

test("cache access errors fail visibly instead of causing paid refetches", async () => {
  let fetches = 0;
  const f = fixture({}, { storage: { get: async () => { throw new Error("Storage unavailable"); } }, fetchTranscript: async () => { fetches++; return captionResponse(); } });
  await assert.rejects(f.service.getTrack(VIDEO), /Storage unavailable/);
  assert.equal(fetches, 0);
});

test("unknown IDs, oversized requests and arbitrary video identifiers are rejected without translating", async () => {
  const f = fixture({ [`digest_${VIDEO}`]: cached() });
  await assert.rejects(f.service.translateSegments(VIDEO, ["made-up-segment"]), /Unknown/);
  await assert.rejects(f.service.translateSegments(VIDEO, Array(5).fill(ids[0])), /1 and 4/);
  await assert.rejects(f.service.translateSegments(VIDEO, [ids[0], ids[0]]), /unique/);
  await assert.rejects(f.service.getTrack("../bad"), /Invalid/);
  assert.equal(f.translatedBatches.length, 0);
});

test("cache migration can preserve its original expiry timestamp while merging later translations", async () => {
  const timestamp = NOW - 20000;
  const f = fixture({ [`digest_${VIDEO}`]: cached({ timestamp }) });
  await f.service.saveDigestCache(VIDEO, { paragraphCache: {} }, { preserveTimestamp: true });
  assert.equal(f.data[`digest_${VIDEO}`].timestamp, timestamp);
});

function backgroundFixture() {
  const events = { addListener() {} };
  const f = fixture({ [`digest_${VIDEO}`]: cached(), ytd_settings: { aiApiKey: "test-secret" } });
  let currentUrl = `https://www.youtube.com/watch?v=${VIDEO}`;
  const broadcasts = [];
  const context = {
    console, URL, setTimeout, clearTimeout, TextDecoder, TextEncoder, AbortController,
    importScripts() {},
    YTD_SETTINGS: { STORAGE_KEY: "ytd_settings", normalize: (value) => value },
    YTD_SUBTITLE_SERVICE: serviceFactory, YTD_TRANSCRIPT_SEGMENTS: segments, YTD_TRANSCRIPT_CLEANUP: cleanup,
    chrome: {
      storage: { local: { ...f.storage, setAccessLevel: async () => {} } },
      runtime: { id: "test-extension", onInstalled: events, onMessage: events, getURL: (p) => `chrome-extension://test-extension/${p}` },
      action: { onClicked: events }, sidePanel: { setPanelBehavior() {} },
      tabs: { onUpdated: events, onActivated: events, get: async () => ({ id: 10, url: currentUrl }), query: async () => [{ id: 10, url: currentUrl }, { id: 11, url: `https://www.youtube.com/watch?v=${OTHER}` }], sendMessage: async (id, message) => broadcasts.push({ id, message }) },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), context);
  return { ...context.__YTD_TRANSLATION_TESTING__, f, broadcasts, setUrl(url) { currentUrl = url; } };
}
const contentSender = () => ({ id: "test-extension", frameId: 0, tab: { id: 10 }, url: `https://www.youtube.com/watch?v=${VIDEO}` });
const panelSender = () => ({ id: "test-extension", url: "chrome-extension://test-extension/sidepanel.html" });

test("subtitle messages require own top-frame YouTube sender and the current tab's exact video", async () => {
  const bg = backgroundFixture();
  const message = { action: "getSubtitleTrack", videoId: VIDEO };
  for (const sender of [undefined, { ...contentSender(), id: "foreign" }, { ...contentSender(), frameId: 1 }, { ...contentSender(), url: `https://youtube.com.evil/watch?v=${VIDEO}` }]) {
    await assert.rejects(bg.handleSubtitleMessage(message, sender));
  }
  bg.setUrl(`https://www.youtube.com/watch?v=${OTHER}`);
  await assert.rejects(bg.handleSubtitleMessage(message, contentSender()), /no longer matches/);
  bg.setUrl(`https://www.youtube.com/watch?v=${VIDEO}`);
  const response = await bg.handleSubtitleMessage(message, contentSender());
  assert.equal(response.videoId, VIDEO);
  assert.equal(JSON.stringify(response).includes("test-secret"), false);
});

test("subtitle requests after same-document navigation use the live video, not the initial page URL", async () => {
  for (const initialUrl of [
    "https://www.youtube.com/", "https://www.youtube.com/@wangzhian/videos",
    `https://www.youtube.com/watch?v=${OTHER}`,
  ]) {
    const bg = backgroundFixture();
    const sender = { ...contentSender(), url: initialUrl, origin: "https://www.youtube.com" };
    const message = { action: "getSubtitleTrack", videoId: VIDEO };
    const response = await bg.handleSubtitleMessage(message, sender);
    assert.equal(response.videoId, VIDEO);
    assert.equal(response.segments.length > 0, true);
    assert.equal(JSON.stringify(response).includes("test-secret"), false);
    // A late old-video request remains invalid even when the original document
    // URL happens to identify that old video.
    await assert.rejects(bg.handleSubtitleMessage({ ...message, videoId: OTHER }, sender), /no longer matches/);
  }
});

test("SPA compatibility still rejects foreign origins, malformed senders and navigation away", async () => {
  const bg = backgroundFixture();
  const message = { action: "getSubtitleTrack", videoId: VIDEO };
  for (const invalid of [
    { ...contentSender(), url: "not-a-url" },
    { ...contentSender(), url: "http://www.youtube.com/" },
    { ...contentSender(), url: "https://www.youtube.com.evil/" },
    { ...contentSender(), origin: "https://evil.example" },
    { ...contentSender(), origin: "null" },
  ]) await assert.rejects(bg.handleSubtitleMessage(message, invalid), /trusted extension context/);
  for (const url of ["https://www.youtube.com/", "https://example.com/", "about:blank", undefined]) {
    bg.setUrl(url);
    await assert.rejects(bg.handleSubtitleMessage(message, contentSender()), /no longer matches/);
  }
});

test("only the own side panel can save digest patches; preference broadcasts contain display state only", async () => {
  const bg = backgroundFixture();
  const message = { action: "saveDigestCache", videoId: VIDEO, patch: { analysis: { summary: "new" } } };
  await assert.rejects(bg.handleSubtitleMessage(message, contentSender()), /Only the Digest panel/);
  await assert.rejects(bg.handleSubtitleMessage(message, { id: "test-extension", url: "chrome-extension://test-extension/options.html" }), /Only the Digest panel/);
  await bg.handleSubtitleMessage(message, panelSender());
  assert.equal(bg.f.data[`digest_${VIDEO}`].analysis.summary, "new");
  await bg.handleSubtitleMessage({ action: "setSubtitlePreference", enabled: true }, contentSender());
  assert.deepEqual(JSON.parse(JSON.stringify(bg.broadcasts)), [{ id: 10, message: { action: "subtitlePreferenceChanged", enabled: true } }, { id: 11, message: { action: "subtitlePreferenceChanged", enabled: true } }]);
  assert.equal(JSON.stringify(bg.broadcasts).includes("test-secret"), false);
});


const multilingualTranscript = (language) => [{
  start: 0, duration: 4, language,
  text: language === "ja" ? "今日は東京で新しいパソコンを紹介します。" :
    language === "ko" ? "오늘은 서울에서 새로운 컴퓨터를 소개합니다." : transcript[0].text,
}];
const multilingualResponse = (language) => ({ success: true, language, transcript: multilingualTranscript(language), availableLanguages: ["en", "ja", "ko"] });

test("reliable original-language detection fetches Japanese and Korean instead of cached English", async () => {
  for (const language of ["ja", "ko"]) {
    const requests = [];
    const f = fixture({ [`digest_${VIDEO}`]: cached() }, {
      resolveLanguage: async (videoId, tabId) => {
        assert.equal(videoId, VIDEO);
        assert.equal(tabId, 42);
        return { language, reason: "original-audio", availableLanguages: ["en", language] };
      },
      fetchTranscript: async (videoId, options) => { requests.push(options.language); return multilingualResponse(options.language); },
    });
    const result = await f.service.getTrack(VIDEO, { tabId: 42 });
    assert.deepEqual(requests, [language]);
    assert.equal(result.sourceLanguage.language, language);
    assert.equal(result.sourceLanguage.reason, "original-audio");
    assert.match(result.trackKey, new RegExp(`:${language}:`));
    assert.equal(f.data[`digest_${VIDEO}`].transcript[0].language, language);
    assert.ok(f.data[`digest_${VIDEO}`].transcriptTracks.en);
    assert.ok(f.data[`digest_${VIDEO}`].transcriptTracks[language]);
  }
});

test("ambiguous original language preserves English; manual Korean selection persists only for this video", async () => {
  const requests = [];
  const f = fixture({ [`digest_${VIDEO}`]: cached() }, {
    resolveLanguage: async () => ({ language: null, reason: "ambiguous", availableLanguages: ["en", "ja", "ko"] }),
    fetchTranscript: async (videoId, { language }) => { requests.push(language); return multilingualResponse(language); },
  });
  assert.deepEqual(await f.service.getSourceLanguage(VIDEO), {
    preference: "auto", language: "en", reason: "fallback", availableLanguages: ["en", "ja", "ko"],
  });
  await f.service.getTrack(VIDEO);
  assert.equal(requests.length, 0);
  const selected = await f.service.setSourceLanguage(VIDEO, "ko");
  assert.equal(selected.reason, "manual");
  assert.equal(selected.language, "ko");
  const restarted = serviceFactory.create(f.dependencies);
  const result = await restarted.getTrack(VIDEO);
  assert.equal(result.sourceLanguage.preference, "ko");
  assert.equal(result.sourceLanguage.language, "ko");
  assert.deepEqual(requests, ["ko"]);
  assert.equal((await restarted.getSourceLanguage(OTHER)).preference, "auto");
  await assert.rejects(restarted.setSourceLanguage(VIDEO, "fr"), /Choose/);
});

test("switching back reuses each language's transcript and completed Chinese translations", async () => {
  const requests = [];
  const f = fixture({}, {
    fetchTranscript: async (videoId, { language }) => { requests.push(language); return multilingualResponse(language); },
  });
  await f.service.setSourceLanguage(VIDEO, "ja");
  const japanese = await f.service.getTrack(VIDEO);
  const jaId = japanese.segments[0].id;
  await f.service.translateSegments(VIDEO, [jaId], { trackKey: japanese.trackKey });
  await f.service.setSourceLanguage(VIDEO, "ko");
  const korean = await f.service.getTrack(VIDEO);
  assert.equal(korean.segments[0].id, jaId); // ID alone is deliberately insufficient.
  assert.notEqual(korean.trackKey, japanese.trackKey);
  await f.service.translateSegments(VIDEO, [jaId], { trackKey: korean.trackKey });
  await f.service.setSourceLanguage(VIDEO, "ja");
  const returned = await f.service.getTrack(VIDEO);
  assert.equal(returned.trackKey, japanese.trackKey);
  assert.ok(returned.translations[jaId]);
  await f.service.translateSegments(VIDEO, [jaId], { trackKey: returned.trackKey });
  assert.deepEqual(requests, ["ja", "ko"]);
  assert.equal(f.translatedBatches.length, 2);
  assert.equal(Object.keys(f.data[`digest_${VIDEO}`].paragraphCache).length, 2);
});

test("old source fetches may cache results but cannot replace the newly selected active transcript", async () => {
  const english = deferred();
  const f = fixture({}, {
    fetchTranscript: async (videoId, { language }) => language === "en" ? english.promise : multilingualResponse(language),
  });
  const old = f.service.getTranscript(VIDEO);
  const rejected = assert.rejects(old, { code: "SUBTITLE_TRACK_CHANGED" });
  await tick();
  await f.service.setSourceLanguage(VIDEO, "ko");
  const current = await f.service.getTranscript(VIDEO);
  english.resolve(multilingualResponse("en"));
  await rejected;
  assert.equal(f.data[`digest_${VIDEO}`].transcriptLanguage, "ko");
  assert.equal(f.data[`digest_${VIDEO}`].transcriptTrackKey, current.trackKey);
  assert.ok(f.data[`digest_${VIDEO}`].transcriptTracks.en);
  await f.service.setSourceLanguage(VIDEO, "en");
  assert.equal((await f.service.getTranscript(VIDEO)).language, "en");
});

test("stale panel track IDs are rejected before translating and old saves cannot replace the active source", async () => {
  const f = fixture({}, { fetchTranscript: async (videoId, { language }) => multilingualResponse(language) });
  const old = await f.service.getTranscript(VIDEO);
  const oldIds = segments.buildPlaybackSegments(old.transcript).map((row) => row.id);
  await f.service.setSourceLanguage(VIDEO, "ko");
  const current = await f.service.getTranscript(VIDEO);
  await assert.rejects(f.service.translateSegments(VIDEO, oldIds, { trackKey: old.trackKey }), { code: "SUBTITLE_TRACK_CHANGED" });
  assert.equal(f.translatedBatches.length, 0);
  await f.service.saveDigestCache(VIDEO, {
    transcript: old.transcript, transcriptLanguage: "en", transcriptText: "Old English",
    analysis: { summary: "Keep existing work" }, videoTitle: "Title",
  });
  const saved = f.data[`digest_${VIDEO}`];
  assert.equal(saved.transcriptLanguage, "ko");
  assert.equal(saved.transcriptTrackKey, current.trackKey);
  assert.deepEqual(saved.analysis, { summary: "Keep existing work" });
});

test("transcript failure markers are source-specific and Japanese requests reject English fallback", async () => {
  let calls = 0;
  const f = fixture({ [`subtitleJobs_${VIDEO}`]: { pending: true, timestamp: NOW } }, {
    fetchTranscript: async () => { calls++; return multilingualResponse("en"); },
  });
  await assert.rejects(f.service.getTrack(VIDEO), /中断/);
  await f.service.setSourceLanguage(VIDEO, "ja");
  await assert.rejects(f.service.getTrack(VIDEO), { code: "SOURCE_LANGUAGE_UNAVAILABLE" });
  assert.equal(calls, 1);
  const restarted = serviceFactory.create(f.dependencies);
  await assert.rejects(restarted.getTrack(VIDEO), { code: "SOURCE_LANGUAGE_UNAVAILABLE" });
  assert.equal(calls, 1);
  assert.ok(f.data[`subtitleJobs_${VIDEO}_ja`]);
  await f.service.setSourceLanguage(VIDEO, "ko");
  await assert.rejects(f.service.getTrack(VIDEO), { code: "SOURCE_LANGUAGE_UNAVAILABLE" });
  assert.equal(calls, 2);
});


test("translation keeps the loaded source when new detection metadata becomes available after the TTL", async () => {
  let time = NOW;
  let detections = 0;
  const f = fixture({}, {
    now: () => time,
    resolveLanguage: async () => {
      detections++;
      return detections === 1 ? { language: null, reason: "ambiguous", availableLanguages: ["en", "ko"] } :
        { language: "ko", reason: "original-audio", availableLanguages: ["en", "ko"] };
    },
    fetchTranscript: async (videoId, { language }) => multilingualResponse(language),
  });
  const loaded = await f.service.getTrack(VIDEO, { tabId: 42 });
  time += 31000;
  const translated = await f.service.translateSegments(VIDEO, [loaded.segments[0].id], { trackKey: loaded.trackKey, tabId: 42 });
  assert.equal(translated.trackKey, loaded.trackKey);
  assert.equal(detections, 1);
  assert.equal(f.translatedBatches[0][0].text, multilingualTranscript("en")[0].text);
  // Explicitly reloading the track may now select the reliable original.
  const reloaded = await f.service.getTrack(VIDEO, { tabId: 42 });
  assert.equal(reloaded.sourceLanguage.language, "ko");
  await assert.rejects(f.service.translateSegments(VIDEO, [loaded.segments[0].id], { trackKey: loaded.trackKey }), { code: "SUBTITLE_TRACK_CHANGED" });
});

test("changing the persisted preference rejects old track translation even after a worker restart", async () => {
  const f = fixture({}, { fetchTranscript: async (videoId, { language }) => multilingualResponse(language) });
  const loaded = await f.service.getTrack(VIDEO);
  await f.service.setSourceLanguage(VIDEO, "ko");
  const restarted = serviceFactory.create(f.dependencies);
  await assert.rejects(restarted.translateSegments(VIDEO, [loaded.segments[0].id], { trackKey: loaded.trackKey }), { code: "SUBTITLE_TRACK_CHANGED" });
  assert.equal(f.translatedBatches.length, 0);
});


test("source selection routes to the sender video and never broadcasts to unrelated videos", async () => {
  const bg = backgroundFixture();
  const response = await bg.handleSubtitleMessage({ action: "setSubtitleSourceLanguage", videoId: VIDEO, preference: "ko", tabId: 999 }, contentSender());
  assert.equal(response.preference, "ko");
  assert.deepEqual(bg.broadcasts.map(item => item.id), [10]);
  assert.equal(bg.broadcasts[0].message.action, "subtitleSourceChanged");
  assert.equal(bg.broadcasts[0].message.videoId, VIDEO);
  assert.equal(JSON.stringify(response).includes("test-secret"), false);
  bg.setUrl(`https://www.youtube.com/watch?v=${OTHER}`);
  await assert.rejects(bg.handleSubtitleMessage({ action: "getSubtitleSourceLanguage", videoId: VIDEO, tabId: 10 }, panelSender()), /不匹配/);
});

test("switching source while a translation claim reads storage rejects the old task without billing", async () => {
  const f = fixture({ [`digest_${VIDEO}`]: cached() });
  const loaded = await f.service.getTrack(VIDEO);
  const entered = deferred();
  const release = deferred();
  const get = f.storage.get;
  let reads = 0;
  f.storage.get = async (key) => {
    const value = await get(key);
    if (key === `digest_${VIDEO}` && ++reads === 2) {
      entered.resolve();
      await release.promise;
    }
    return value;
  };
  const request = f.service.translateSegments(VIDEO, [ids[0]], { trackKey: loaded.trackKey });
  const rejected = assert.rejects(request, { code: "SUBTITLE_TRACK_CHANGED" });
  await entered.promise;
  const changed = f.service.setSourceLanguage(VIDEO, "ko");
  release.resolve();
  await Promise.all([rejected, changed]);
  assert.equal(f.translatedBatches.length, 0);
});

test("switching source during active-track storage reads cannot return the old transcript as current", async () => {
  const f = fixture({ [`digest_${VIDEO}`]: cached() });
  const entered = deferred();
  const release = deferred();
  const get = f.storage.get;
  let reads = 0;
  f.storage.get = async (key) => {
    const value = await get(key);
    if (key === `digest_${VIDEO}` && ++reads === 2) {
      entered.resolve();
      await release.promise;
    }
    return value;
  };
  const request = f.service.getTranscript(VIDEO);
  const rejected = assert.rejects(request, { code: "SUBTITLE_TRACK_CHANGED" });
  await entered.promise;
  const changed = f.service.setSourceLanguage(VIDEO, "ko");
  release.resolve();
  await Promise.all([rejected, changed]);
  assert.equal(f.data[`ytd_source_language_${VIDEO}`], "ko");
  assert.equal(f.data[`digest_${VIDEO}`].transcriptSourcePreference, undefined);
});
