const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function loadSidepanelHelpers({
  sendMessage = () => Promise.resolve({}),
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
  localStorage = {},
  querySelectorImpl = () => null,
} = {}) {
  const listeners = { addListener() {} };
  const sessionStorage = {};
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    setInterval() {},
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: querySelectorImpl,
      getElementById: () => null,
      createElement: () => {
        let value = "";
        return {
          set textContent(text) {
            value = String(text);
          },
          get innerHTML() {
            return value
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;");
          },
        };
      },
    },
    chrome: {
      runtime: { onMessage: listeners, sendMessage },
      storage: {
        local: {
          get: async (key) => ({ [key]: localStorage[key] }),
          set: async (values) => Object.assign(localStorage, values),
          remove: async (key) => { delete localStorage[key]; },
        },
        session: {
          get: async (key) => ({ [key]: sessionStorage[key] }),
          set: async (values) => Object.assign(sessionStorage, values),
        },
      },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: { onUpdated: listeners, onActivated: listeners },
    },
    YTD_SETTINGS: {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("transcript-cleanup.js"), sandbox);
  vm.runInNewContext(read("transcript-segments.js"), sandbox);
  vm.runInNewContext(read("sidepanel.js"), sandbox);
  return {
    ...sandbox.__YTD_TRANSCRIPT_TESTING__,
    setTranscriptState(state) {
      sandbox.testTranscriptState = state;
      vm.runInNewContext(`
        currentVideoId = testTranscriptState.videoId;
        currentTranscript = testTranscriptState.transcript;
        currentTranscriptText = testTranscriptState.transcriptText;
        currentTranscriptMode = testTranscriptState.mode;
        currentTrackKey = testTranscriptState.trackKey || null;
        youtubeTabId = testTranscriptState.tabId || null;
        transcriptParagraphCache = new Map(Object.entries(testTranscriptState.paragraphCache || {}));
      `, sandbox);
    },
  };
}

function loadBackgroundHelpers({
  settings = {
    provider: "deepseek",
    aiApiKey: "test-key",
    aiBaseUrl: "https://api.deepseek.com",
    aiModel: "deepseek-v4-flash",
  },
  fetchImpl = fetch,
  transcriptService,
  initialLocalStorage = {},
  setTimeoutImpl = () => 0,
  clearTimeoutImpl = () => {},
  sidePanel = {
    setPanelBehavior() {},
    setOptions: () => Promise.resolve(),
  },
} = {}) {
  const listeners = { addListener() {} };
  const localStorage = { ...initialLocalStorage, ytd_settings: settings };
  const sandbox = {
    console,
    crypto: require("node:crypto").webcrypto,
    URL,
    TextDecoder,
    TextEncoder,
    fetch: fetchImpl,
    AbortController,
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    importScripts() {},
    YTD_TRANSCRIPT_SEGMENTS: require("../transcript-segments.js"),
    YTD_SUBTITLE_SERVICE: transcriptService
      ? { create: () => transcriptService }
      : require("../subtitle-service.js"),
    chrome: {
      storage: {
        local: {
          setAccessLevel: () => Promise.resolve(),
          get: async (key) => {
            if (key === null) return { ...localStorage };
            if (Array.isArray(key)) {
              return Object.fromEntries(key.map((item) => [item, localStorage[item]]));
            }
            return { [key]: localStorage[key] };
          },
          set: async (values) => Object.assign(localStorage, values),
          remove: async (keys) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              delete localStorage[key];
            }
          },
        },
      },
      action: { onClicked: listeners },
      sidePanel,
      runtime: {
        onInstalled: listeners,
        onMessage: listeners,
        openOptionsPage() {},
        getURL: (resourcePath) => `chrome-extension://test/${resourcePath}`,
        sendMessage: () => Promise.resolve({ success: true }),
      },
      tabs: { onUpdated: listeners, onActivated: listeners, query: async () => [{ id: 17 }] },
    },
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: (value) => value,
      chatCompletionsUrl: (baseUrl) => `${baseUrl}/chat/completions`,
      canonicalYouTubeUrl: (videoId) =>
        `https://www.youtube.com/watch?v=${videoId}`,
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("transcript-cleanup.js"), sandbox);
  vm.runInNewContext(read("transcript-language.js"), sandbox);
  vm.runInNewContext(read("background.js"), sandbox);
  return sandbox.__YTD_TRANSLATION_TESTING__;
}

test("non-YouTube tabs explicitly close before their panel is disabled", async () => {
  const calls = [];
  const background = loadBackgroundHelpers({
    sidePanel: {
      setPanelBehavior() {},
      close: async (options) => calls.push(["close", options]),
      setOptions: async (options) => calls.push(["setOptions", options]),
    },
  });

  await background.updatePanelForTab(17, "https://example.com/page", 4);

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["close", { tabId: 17 }],
    ["setOptions", { tabId: 17, enabled: false }],
  ]);
});

test("a global panel closes by window when the tab close is rejected", async () => {
  const calls = [];
  const background = loadBackgroundHelpers({
    sidePanel: {
      setPanelBehavior() {},
      close: async (options) => {
        calls.push(["close", options]);
        if (options.tabId) throw new Error("Global panel");
      },
      setOptions: async (options) => calls.push(["setOptions", options]),
    },
  });

  await background.updatePanelForTab(17, "https://example.com/page", 4);

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["close", { tabId: 17 }],
    ["close", { windowId: 4 }],
    ["setOptions", { tabId: 17, enabled: false }],
  ]);
});

function createFakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay, active: true });
      return id;
    },
    clearTimeout(id) {
      const timer = timers.get(id);
      if (timer) timer.active = false;
    },
    fireActive(delay) {
      const match = [...timers.entries()].find(
        ([, timer]) => timer.active && timer.delay === delay,
      );
      assert.ok(match, `Expected an active ${delay}ms timer`);
      match[1].active = false;
      match[1].callback();
    },
    activeCount(delay) {
      return [...timers.values()].filter(
        (timer) => timer.active && timer.delay === delay,
      ).length;
    },
    createdCount(delay) {
      return [...timers.values()].filter((timer) => timer.delay === delay).length;
    },
  };
}

function streamingResponse(chunks, { ok = true, status = 200 } = {}) {
  let index = 0;
  return {
    ok,
    status,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true };
            return { done: false, value: chunks[index++] };
          },
          async cancel() {},
        };
      },
    },
  };
}

const encode = (value) => new TextEncoder().encode(value);
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("the header exposes one universal language control for all result tabs", () => {
  const html = read("sidepanel.html");
  const js = read("sidepanel.js");
  assert.match(html, /id="transcriptModeControl"[\s\S]*aria-label="Content language"/);
  assert.match(html, /id="transcriptModeControl"[\s\S]*id="tabsNav"/);
  assert.match(html, /data-transcript-mode="original"[\s\S]*?>Original</);
  assert.match(html, /data-transcript-mode="zh"[\s\S]*?>\u4e2d\u6587</);
  assert.match(html, /data-transcript-mode="bilingual"[\s\S]*?>\u53cc\u8bed</);
  assert.match(js, /handleDisplayLanguageModeChange\(button\.dataset\.transcriptMode\)/);
  assert.match(js, /action: "translateSubtitleSegments"/);
  assert.match(js, /contentType: "interfaceBatch"/);
  assert.match(js, /translateOverviewContent/);
  assert.match(js, /translateNotesContent/);
  assert.doesNotMatch(js, /English \+ Chinese/);
  assert.doesNotMatch(`${html}\n${js}`, /From video subtitles/);
});

test("new videos default to Original while returning videos restore their choice", async () => {
  const { loadDisplayLanguageMode, saveDisplayLanguageMode } =
    loadSidepanelHelpers();

  await saveDisplayLanguageMode("video-a", "bilingual");
  assert.equal(await loadDisplayLanguageMode("video-a"), "bilingual");
  assert.equal(await loadDisplayLanguageMode("unseen-video"), "original");
});

test("Overview shares the Transcript batch generation and retries when opened", () => {
  const js = read("sidepanel.js");
  const transcriptFunction = js.match(
    /async function translateTranscript\([^\n]*\)[\s\S]*?\n}\n\nfunction setTranslatingSpinner/,
  )?.[0];

  assert.ok(transcriptFunction);
  assert.doesNotMatch(transcriptFunction, /translationGeneration \+= 1/);
  assert.match(js, /const TRANSLATION_BATCH_SIZE = 3/);
  assert.match(
    js,
    /const batch = missing\.slice\(start, start \+ TRANSLATION_BATCH_SIZE\)[\s\S]*?rerender\(\);[\s\S]*?await updateCache\(\)/,
  );
  assert.match(
    js,
    /tabName === "overview"[\s\S]*?currentAnalysis[\s\S]*?currentTranscriptMode !== "original"[\s\S]*?translateOverviewContent\(\)/,
  );
  assert.match(
    js,
    /Translate only the visible tab[\s\S]*?tabName === "notes"[\s\S]*?translateNotesContent\(\)/,
  );
  assert.match(
    js,
    /activeTabName === "overview"[\s\S]*?translateOverviewContent\(\)[\s\S]*?activeTabName === "notes"[\s\S]*?translateNotesContent\(\)[\s\S]*?activeTabName === "transcript"[\s\S]*?translateTranscript\(\)/,
  );
});

test("transcript reading position survives a side panel close", async () => {
  const { saveTranscriptViewState, loadTranscriptViewState } =
    loadSidepanelHelpers();

  await saveTranscriptViewState("video-a", 427.5);
  const restored = await loadTranscriptViewState("video-a");

  assert.deepEqual(JSON.parse(JSON.stringify(restored)), {
    videoId: "video-a",
    scrollTop: 427.5,
  });
});

test("selected transcript notes keep exact text and row timestamp", async () => {
  const providerMustNotRun = async () => {
    throw new Error("Selected note must not call a provider");
  };
  const { handleSaveNote } = loadBackgroundHelpers({
    fetchImpl: providerMustNotRun,
  });

  const result = await handleSaveNote(
    "video123",
    92.9,
    "Test video",
    "Test channel",
    "  The selected words stay exact.  ",
  );

  assert.equal(result.success, true);
  assert.equal(result.note.text, "The selected words stay exact.");
  assert.equal(result.note.rawText, "The selected words stay exact.");
  assert.equal(result.note.timestamp, "1:32");
  assert.equal(result.note.timestampSeconds, 92);
  assert.equal(
    result.note.timestampedUrl,
    "https://www.youtube.com/watch?v=video123&t=92s",
  );
});

test("semantic segmentation rebuilds sentences across caption boundaries", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const segments = groupTranscriptEntries(
    [
      { start: 0, text: "Caption boundaries should" },
      { start: 2, text: "not break a complete sentence." },
      { start: 5, text: "The next thought also" },
      { start: 7, text: "stays together!" },
    ],
    { minChars: 1, idealChars: 100, maxChars: 320, maxSeconds: 20 },
  );
  assert.equal(segments.length, 2);
  assert.equal(
    segments[0].text,
    "Caption boundaries should not break a complete sentence.",
  );
  assert.equal(segments[0].start, 0);
  assert.equal(segments[1].text, "The next thought also stays together!");
  assert.equal(segments[1].start, 5);
});

test("a huge raw Supadata entry is split into seekable bounded segments", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const text = Array.from({ length: 900 }, (_, index) => `word${index}`).join(" ");
  const segments = groupTranscriptEntries([
    { start: 12, duration: 90, text },
  ]);
  assert.ok(segments.length > 8);
  assert.ok(segments.every((segment) => segment.text.length <= 384));
  assert.equal(segments[0].start, 12);
  assert.ok(segments.at(-1).start > segments[0].start);
  assert.ok(segments.every((segment) => /^segment-\d+-\d+$/.test(segment.id)));
});

test("Chinese sentence and clause punctuation creates semantic guardrails", () => {
  const { groupTranscriptEntries } = loadSidepanelHelpers();
  const segments = groupTranscriptEntries(
    [
      { start: 0, text: "这是一个被字幕切开的" },
      { start: 2, text: "完整句子。这是第二个想法，" },
      { start: 5, text: "也应该保持语义完整！" },
    ],
    { minChars: 1, idealChars: 100, maxChars: 320, maxSeconds: 20 },
  );
  assert.equal(segments.length, 2);
  assert.equal(segments[0].text, "这是一个被字幕切开的完整句子。");
  assert.equal(segments[1].text, "这是第二个想法，也应该保持语义完整！");
});

test("structured translation batches align by stable ID and expose missing fallback", () => {
  const sidepanel = loadSidepanelHelpers();
  const background = loadBackgroundHelpers();
  const source = [
    { id: "segment-0-0", text: "A complete first sentence." },
    { id: "segment-1-5000", text: "A complete second sentence." },
  ];
  assert.deepEqual(
    JSON.parse(JSON.stringify(background.validateTranscriptBatchRequest({ segments: source }))),
    source,
  );

  const normalized = background.normalizeTranslatedSegmentBatch(
    {
      segments: [
        { id: "unknown", text: "\u5ffd\u7565" },
        { id: "segment-1-5000", text: "\u7b2c\u4e8c\u4e2a\u5b8c\u6574\u53e5\u5b50\u3002" },
      ],
    },
    source,
  );
  const aligned = sidepanel.alignTranslatedSegmentBatch(
    source,
    normalized.segments,
  );
  assert.equal(aligned[0].id, source[0].id);
  assert.equal(aligned[0].text, "");
  assert.match(aligned[0].error, /unavailable/i);
  assert.equal(aligned[1].text, "\u7b2c\u4e8c\u4e2a\u5b8c\u6574\u53e5\u5b50\u3002");
});

test("translated-only omits English while bilingual renders aligned English and Chinese", () => {
  const { renderTranscriptSegmentContent } = loadSidepanelHelpers();
  const segment = { id: "segment-0-0", text: "Original English sentence." };
  const translatedOnly = renderTranscriptSegmentContent(
    segment,
    "zh",
    "\u4e2d\u6587\u8bd1\u6587\u3002",
    "",
  );
  const bilingual = renderTranscriptSegmentContent(
    segment,
    "bilingual",
    "\u4e2d\u6587\u8bd1\u6587\u3002",
    "",
  );
  assert.doesNotMatch(translatedOnly, /Original English sentence/);
  assert.match(translatedOnly, /\u4e2d\u6587\u8bd1\u6587/);
  assert.match(bilingual, /transcript-original/);
  assert.match(bilingual, /Original English sentence/);
  assert.match(bilingual, /\u4e2d\u6587\u8bd1\u6587/);
});

test("subtitle formatting tags render in original and translated segment text", () => {
  const { renderTranscriptSegmentContent } = loadSidepanelHelpers();
  const html = renderTranscriptSegmentContent(
    {
      id: "segment-0-0",
      text: "Think <i>deeply</i>, <b>carefully</b>, and <u>clearly</u>.<br>Next line.",
    },
    "bilingual",
    "\u5b57\u5730<i>\u601d\u8003</i>\u7684\u3002<strong>\u91cd\u70b9</strong>",
    "",
  );

  assert.match(html, /Think <i>deeply<\/i>/);
  assert.match(html, /<b>carefully<\/b>/);
  assert.match(html, /<u>clearly<\/u>\.<br>Next line/);
  assert.match(html, /\u5b57\u5730<i>\u601d\u8003<\/i>\u7684\u3002<strong>\u91cd\u70b9<\/strong>/);
});

test("subtitle markup renderer keeps attributed and arbitrary HTML escaped", () => {
  const { renderSubtitleInlineMarkup } = loadSidepanelHelpers();
  const html = renderSubtitleInlineMarkup(
    '<img src=x onerror="alert(1)"><i onclick="alert(2)">unsafe</i><script>alert(3)</script>',
  );

  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;i onclick=&quot;alert\(2\)&quot;&gt;unsafe<\/i>/);
  assert.match(html, /&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img\b|<i\s+onclick|<script\b/);
});

test("background rejects unsupported language fallthrough and malformed batches", () => {
  const source = read("background.js");
  const { validateTranscriptBatchRequest } = loadBackgroundHelpers();
  assert.match(source, /targetLanguage !== "zh"/);
  assert.match(source, /\["transcriptBatch", "interfaceBatch"\]/);
  assert.throws(
    () => validateTranscriptBatchRequest({ segments: [] }),
    /1 to 4 segments/,
  );
  assert.throws(
    () =>
      validateTranscriptBatchRequest({
        segments: [
          { id: "duplicate", text: "first" },
          { id: "duplicate", text: "second" },
        ],
      }),
    /unique and stable/,
  );
});

test("all AI product requests use DeepSeek non-thinking and JSON behavior", async () => {
  const deepSeekRequests = [];
  const successfulFetch = (requests) => async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "translated" } }],
      }),
    };
  };

  const deepSeek = loadBackgroundHelpers({
    fetchImpl: successfulFetch(deepSeekRequests),
  });
  const deepSeekResult = await deepSeek.requestAiCompletion({
    maxTokens: 128,
    responseFormat: { type: "json_object" },
    messages: [{ role: "user", content: "Hello." }],
  });
  assert.equal(deepSeekResult.text, "translated");
  assert.deepEqual(deepSeekRequests[0].thinking, { type: "disabled" });
  assert.deepEqual(deepSeekRequests[0].response_format, {
    type: "json_object",
  });

  const backgroundSource = read("background.js");
  assert.equal(
    (backgroundSource.match(/await requestAiCompletion\(\{/g) || []).length,
    4,
  );
  assert.doesNotMatch(backgroundSource, /disableThinking/);
  for (const callPath of [
    "handleAnalyzeTranscript",
    "cleanupNoteText",
    "handleExplainSelection",
    "callAiTranslation",
  ]) {
    assert.match(
      backgroundSource,
      new RegExp(`async function ${callPath}\\([\\s\\S]*?requestAiCompletion\\(\\{`),
    );
  }
});

test("blank-line chunks reset provider idle timeout and valid JSON succeeds", async () => {
  const timers = createFakeTimers();
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async () =>
      streamingResponse([
        encode("\n"),
        encode("\n"),
        encode('{"choices":[{"message":{"content":"translated"}}]}'),
      ]),
  });

  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, true);
  assert.equal(result.text, "translated");
  assert.equal(timers.createdCount(50_000), 5);
  assert.equal(timers.activeCount(50_000), 0);
  assert.equal(timers.activeCount(120_000), 0);
});

test("provider idle silence aborts with a distinct Retry-able error", async () => {
  const timers = createFakeTimers();
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async (_url, { signal }) => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () =>
            new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              });
            }),
        }),
      },
    }),
  });

  const request = helpers.callAiTranslation("Translate.", "Hello.");
  await nextTurn();
  timers.fireActive(50_000);
  const result = await request;
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_IDLE_TIMEOUT");
  assert.match(result.error, /inactive for 50 seconds.*Retry/i);
  assert.equal(timers.activeCount(120_000), 0);
});

test("blank-line keepalives cannot evade the provider hard cap", async () => {
  const timers = createFakeTimers();
  let releaseRead;
  let signal;
  const helpers = loadBackgroundHelpers({
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: () =>
              new Promise((resolve, reject) => {
                releaseRead = () => resolve({ done: false, value: encode("\n") });
                signal.addEventListener("abort", () => {
                  const error = new Error("aborted");
                  error.name = "AbortError";
                  reject(error);
                }, { once: true });
              }),
          }),
        },
      };
    },
  });

  const request = helpers.callAiTranslation("Translate.", "Hello.");
  await nextTurn();
  releaseRead();
  await nextTurn();
  releaseRead();
  await nextTurn();
  assert.equal(timers.activeCount(50_000), 1);
  timers.fireActive(120_000);
  const result = await request;
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_HARD_TIMEOUT");
  assert.match(result.error, /120-second limit.*Retry/i);
  assert.equal(timers.activeCount(50_000), 0);
});

test("provider response reader accepts leading whitespace before JSON", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () =>
      streamingResponse([
        encode('  \n\t{"choices":[{"message":{"content":"ok"}}]}'),
      ]),
  });
  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, true);
  assert.equal(result.text, "ok");
});

test("provider response reader rejects bodies over 2 MiB", async () => {
  const helpers = loadBackgroundHelpers({
    fetchImpl: async () =>
      streamingResponse([new Uint8Array(2 * 1024 * 1024 + 1)]),
  });
  const result = await helpers.callAiTranslation("Translate.", "Hello.");
  assert.equal(result.success, false);
  assert.equal(result.code, "AI_RESPONSE_TOO_LARGE");
  assert.match(result.error, /2 MiB limit/);
});

test("DeepSeek retries one empty transcript JSON response without response_format", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: requests.length === 1
                ? ""
                : '{"segments":[{"id":"segment-0-0","text":"\u4e2d\u6587\u8bd1\u6587\u3002"}]}',
            },
          }],
        }),
      };
    },
  });
  const result = await helpers.handleTranslateContent(
    { segments: [{ id: "segment-0-0", text: "English source sentence." }] },
    "transcriptBatch",
    "zh",
    "Video",
  );
  assert.equal(result.success, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].response_format, { type: "json_object" });
  assert.equal(Object.hasOwn(requests[1], "response_format"), false);
  assert.equal(requests[0].max_tokens, 1536);
});

test("interface batches use the dedicated Overview and Notes translation prompt", async () => {
  const requests = [];
  const helpers = loadBackgroundHelpers({
    fetchImpl: async (url, options) => {
      if (url.startsWith("chrome-extension://")) {
        return { ok: true, text: async () => read("prompts/translation.md") };
      }
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: '{"segments":[{"id":"note-1","text":"\u4e2d\u6587\u7b14\u8bb0\u3002"}]}',
            },
          }],
        }),
      };
    },
  });

  const result = await helpers.handleTranslateContent(
    { segments: [{ id: "note-1", text: "Saved note." }] },
    "interfaceBatch",
    "zh",
    "Video",
  );

  assert.equal(result.success, true);
  assert.equal(result.translatedContent.segments[0].text, "\u4e2d\u6587\u7b14\u8bb0\u3002");
  assert.match(
    requests[0].messages[0].content,
    /chapter titles, summaries, quotes, and saved notes/,
  );
});

test("translation message watchdog rejects, clears its timer, and ignores late replies", async () => {
  let timeoutCallback;
  let timeoutDelay;
  let resolveMessage;
  let clearCount = 0;
  const helpers = loadSidepanelHelpers({
    sendMessage: () =>
      new Promise((resolve) => {
        resolveMessage = resolve;
      }),
    setTimeoutImpl(callback, delay) {
      timeoutCallback = callback;
      timeoutDelay = delay;
      return 73;
    },
    clearTimeoutImpl(id) {
      assert.equal(id, 73);
      clearCount += 1;
    },
  });

  const request = helpers.sendTranslationMessage({
    action: "translateContent",
  });
  assert.equal(timeoutDelay, 130_000);
  timeoutCallback();
  await assert.rejects(request, /timed out after 130 seconds.*Retry/i);
  assert.equal(clearCount, 1);

  resolveMessage({ success: true });
  await Promise.resolve();
  assert.equal(clearCount, 1);

  let successTimeoutCallback;
  let successClearCount = 0;
  const successfulHelpers = loadSidepanelHelpers({
    sendMessage: () => Promise.resolve({ success: true }),
    setTimeoutImpl(callback) {
      successTimeoutCallback = callback;
      return 91;
    },
    clearTimeoutImpl(id) {
      assert.equal(id, 91);
      successClearCount += 1;
    },
  });
  assert.deepEqual(
    await successfulHelpers.sendTranslationMessage({
      action: "translateContent",
    }),
    { success: true },
  );
  assert.equal(successClearCount, 1);
  successTimeoutCallback();
  assert.equal(successClearCount, 1);
});

test("Chinese prompt preserves natural bilingual-learning style rules", () => {
  const prompt = read("prompts/translation.md");
  assert.match(prompt, /Translate the complete thought/);
  assert.match(prompt, /Use 你, never 您/);
  assert.match(prompt, /spaces between Chinese and adjacent English words or digits/);
  assert.match(prompt, /source-language `text`/);
});

test("immediate and polled captions clean noise before display and AI input", async () => {
  const payload = { lang: "en", content: [
    { text: "[music]", offset: 0, duration: 7000 },
    { text: ">> [laughter] Uh, the screen is peeling here.", offset: 7000, duration: 5000 },
    { text: "It got [music] completely bent.", offset: 12000, duration: 4000 },
  ] };
  const results = [];
  for (const asynchronous of [false, true]) {
    let calls = 0;
    const helpers = loadBackgroundHelpers({
      settings: { supadataApiKey: "test-supadata" },
      setTimeoutImpl(callback) { callback(); return 1; },
      fetchImpl: async (url) => {
        calls += 1;
        if (calls === 1) {
          assert.equal(new URL(url).searchParams.get("mode"), "native");
          return asynchronous
            ? { status: 202, ok: true, json: async () => ({ jobId: "test-job" }) }
            : { status: 200, ok: true, json: async () => payload };
        }
        assert.match(url, /transcript\/test-job$/);
        return { ok: true, json: async () => ({ ...payload, status: "completed" }) };
      },
    });
    const result = await helpers.handleFetchTranscript("video123");
    assert.equal(result.success, true);
    assert.equal(result.transcript[0].start, 7);
    assert.equal(result.transcript[0].duration, 5);
    assert.equal(result.transcript.length, 2);
    assert.equal(result.transcriptText, "the screen is peeling here. It got completely bent.");
    assert.equal(result.transcriptTextTimestamped,
      "[0:07] the screen is peeling here.\n[0:12] It got completely bent.");
    assert.equal(calls, asynchronous ? 2 : 1);
    results.push(JSON.parse(JSON.stringify(result)));
  }
  assert.deepEqual(results[0], results[1]);
});

test("noise-only responses are explicitly empty and keep meaningful bracket content", () => {
  const { parseTranscriptResponse } = loadBackgroundHelpers();
  assert.equal(parseTranscriptResponse({ content: [
    { text: "[music]", offset: 0 }, { text: "Uh, um...", offset: 3000 },
  ] }).error, "EMPTY_TRANSCRIPT");
  const result = parseTranscriptResponse({ content: [
    { text: "The GPU is [RTX 5090], not [RTX 4090].", offset: 12000, lang: "en" },
  ] });
  assert.equal(result.transcript[0].text, "The GPU is [RTX 5090], not [RTX 4090].");
});

test("cache migration cleans locally without changing credentials, notes, or expiry", async () => {
  const timestamp = Date.now();
  const original = {
    transcriptTrackKey: "track-en",
    timestamp, analysis: { summary: "Existing overview" },
    transcript: [
      { text: "[music]", start: 0, duration: 7, language: "en" },
      { text: "[laughter] Uh, the screen is peeling.", start: 7, duration: 5, language: "en" },
    ],
    transcriptText: "stale [music] text",
    transcriptTimestamped: "[0:00] stale [music] text",
    paragraphCache: { "video123:zh:semantic:segment-0-0": "旧的[音乐]译文" },
    interfaceCache: { "overview-key": "原有概览译文" },
  };
  const localStorage = {
    digest_video123: original,
    ytd_settings: { aiApiKey: "test-key" },
    notes: [{ text: "Saved note [music] literally quoted" }],
  };
  const credentials = localStorage.ytd_settings;
  const notes = localStorage.notes;
  const helpers = loadSidepanelHelpers({ localStorage, sendMessage: async (message) => {
    if (message.action === "fetchTranscript") return {
      success: true, trackKey: "track-en", transcript: original.transcript,
    };
    assert.equal(message.action, "saveDigestCache", "Migration must not translate");
    localStorage[`digest_${message.videoId}`] = message.patch;
    return { success: true };
  } });
  const result = await helpers.loadFromCache("video123");
  assert.equal(result.transcriptText, "the screen is peeling.");
  assert.equal(result.transcriptTimestamped, "[0:07] the screen is peeling.");
  assert.equal(result.transcript[0].start, 7);
  assert.equal(result.timestamp, timestamp);
  assert.equal(Object.keys(result.paragraphCache).length, 0);
  assert.deepEqual(result.analysis, original.analysis);
  assert.deepEqual(result.interfaceCache, original.interfaceCache);
  assert.equal(localStorage.ytd_settings, credentials);
  assert.equal(localStorage.notes, notes);
  assert.equal(localStorage.digest_video123.transcriptCleanupVersion, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(await helpers.loadFromCache("video123"))),
    JSON.parse(JSON.stringify(result)));
});

test("new cache identity prevents a reused timestamp ID from displaying another source's translation", () => {
  const { transcriptTranslationCacheKey } = loadSidepanelHelpers();
  const first = { id: "segment-0-0", text: "First complete thought." };
  const second = { ...first, text: "A different complete thought." };
  assert.notEqual(transcriptTranslationCacheKey(first, "video123"),
    "video123:zh:semantic:segment-0-0");
  assert.notEqual(transcriptTranslationCacheKey(first, "video123"),
    transcriptTranslationCacheKey(second, "video123"));
});

test("copied and exported transcript text agrees across cleaned language modes", () => {
  const helpers = loadSidepanelHelpers();
  const videoId = "video123";
  const cache = helpers.cleanCachedTranscript({ transcript: [
    { text: "[music]", start: 0, duration: 7 },
    { text: "[laughter] Uh, the screen is peeling.", start: 7, duration: 5 },
  ] }, videoId);
  const segments = helpers.groupTranscriptEntries(cache.transcript);
  assert.equal(segments[0].start, 7);
  const key = helpers.transcriptTranslationCacheKey(segments[0], videoId);
  const migrated = helpers.cleanCachedTranscript({ ...cache,
    paragraphCache: { [key]: "[笑声]屏幕这里在翘边。" },
  }, videoId);
  for (const mode of ["original", "zh", "bilingual"]) {
    helpers.setTranscriptState({ ...migrated, videoId, mode });
    const displayed = helpers.getDisplayedTranscriptText();
    assert.doesNotMatch(displayed, /\[music\]|\[laughter\]|\[笑声\]|\bUh\b/);
    if (mode !== "zh") assert.match(displayed, /the screen is peeling/);
    if (mode !== "original") assert.match(displayed, /屏幕这里在翘边/);
  }
});

test("translated sound cues are cleaned only for transcript output", () => {
  const { normalizeTranslatedSegmentBatch } = loadBackgroundHelpers();
  const source = [{ id: "a", text: "The screen is peeling here." }];
  const response = { segments: [{ id: "a", text: "[笑声]屏幕这里在翘边。" }] };
  assert.equal(normalizeTranslatedSegmentBatch(response, source, true).segments[0].text,
    "屏幕这里在翘边。");
  assert.equal(normalizeTranslatedSegmentBatch(response, source).segments[0].text,
    "[笑声]屏幕这里在翘边。");
  assert.equal(normalizeTranslatedSegmentBatch({ segments: [{ id: "a", text: "[音乐]" }] },
    source, true).segments[0].text, "");
});

test("saving a note before the first spoken caption never chooses the final sentence", async () => {
  const { handleSaveNote } = loadBackgroundHelpers({
    initialLocalStorage: { digest_abcdefghijk: { timestamp: Date.now(), transcript: [
      { text: "[music]", start: 0, duration: 20 },
      { text: "Opening speech.", start: 20, duration: 5 },
      { text: "Final speech.", start: 900, duration: 5 },
    ] } },
    fetchImpl: () => { throw new Error("Silent intro note must not call an API"); },
  });
  const result = await handleSaveNote("abcdefghijk", 5, "Test", "Test channel");
  assert.equal(result.success, false);
  assert.match(result.error, /No spoken caption/);
});

test("language information survives ingestion, cached cleanup, and grouping", () => {
  const { parseTranscriptResponse } = loadBackgroundHelpers();
  const helpers = loadSidepanelHelpers();
  for (const [lang, text] of [["de", "Er ist hier. Es geht um Sicherheit."],
    ["da", "Han er lærer."]]) {
    const response = parseTranscriptResponse({ lang, content: [
      { text: `[music] ${text}`, offset: 0, duration: 4000 },
    ] });
    const cleaned = helpers.cleanCachedTranscript({ transcript: response.transcript }, "video123");
    assert.equal(cleaned.transcriptText, text);
    assert.equal(helpers.groupTranscriptEntries(cleaned.transcript)[0].text, text);
  }
});

test("player notes use the selected shared source instead of an obsolete English cache", async () => {
  const calls = [];
  const background = loadBackgroundHelpers({
    settings: {},
    initialLocalStorage: { digest_abcdefghijk: { transcript: [{ start: 0, text: "Old English" }] } },
    transcriptService: { getTranscript: async (id, options) => {
      calls.push({ id, options });
      return { transcript: [{ start: 0, text: "한국어 자막입니다." }] };
    } },
    fetchImpl: () => { throw new Error("Must reuse shared transcript service"); },
  });
  const result = await background.handleSaveNote("abcdefghijk", 1, "Video", "Channel", undefined, 42);
  assert.equal(result.success, true);
  assert.equal(result.note.rawText, "한국어 자막입니다.");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ id: "abcdefghijk", options: { tabId: 42 } }]);
});

test("a shared subtitle failure does not silently issue a second caption request for notes", async () => {
  const background = loadBackgroundHelpers({
    transcriptService: { getTranscript: async () => { throw new Error("字幕暂不可用，请重试"); } },
    fetchImpl: () => { throw new Error("Unexpected additional provider request"); },
  });
  const result = await background.handleSaveNote("abcdefghijk", 1, "Video", "Channel");
  assert.equal(result.success, false);
  assert.match(result.error, /字幕暂不可用/);
});


test("sidepanel uses canonical shared translation IDs, renders partial errors, and merges cache through background", async () => {
  const calls = [];
  const copies = [{ outerHTML: "" }, { outerHTML: "" }];
  const classes = [new Map(), new Map()];
  const transcript = [
    { start: 0, duration: 5, text: "This full paragraph is long enough to form a separate semantic transcript segment." },
    { start: 5, duration: 5, text: "This second paragraph needs its own translation and must never borrow the first one." },
  ];
  let track;
  const helpers = loadSidepanelHelpers({
    querySelectorImpl: (selector) => {
      const index = track?.findIndex(s => selector.includes(`data-segment-id="${s.id}"`)) ?? -1;
      return index < 0 ? null : {
        querySelector: value => value === ".transcript-copy" ? copies[index] : null,
        classList: { toggle: (name, state) => classes[index].set(name, state) },
      };
    },
    sendMessage: async message => {
      calls.push(message);
      if (message.action === "saveDigestCache") return { success: true };
      assert.equal(message.action, "translateSubtitleSegments");
      return { videoId: "abcdefghijk", segments: [
        { id: track[1].id, text: "", error: "Temporary provider failure" },
        { id: track[0].id, text: "第一段的准确译文。" },
      ] };
    },
  });
  track = helpers.groupTranscriptEntries(transcript);
  helpers.setTranscriptState({videoId:"abcdefghijk",transcript,transcriptText:"source",mode:"bilingual",tabId:21,trackKey:"track-en"});
  await helpers.requestTranscriptTranslationBatch([0,1], track, 0, "abcdefghijk", "bilingual", true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
    action: "translateSubtitleSegments", videoId:"abcdefghijk", tabId:21, trackKey:"track-en", segmentIds:Array.from(track, s=>s.id), retry:true,
  });
  assert.match(copies[0].outerHTML, /第一段的准确译文/);
  assert.match(copies[1].outerHTML, /Temporary provider failure/);
  assert.equal(classes[0].get("translated"),true);
  assert.equal(classes[1].get("translation-failed"),true);
  const save = calls.find(message => message.action === "saveDigestCache");
  assert.equal(Object.keys(save.patch.paragraphCache).length,1);
  assert.equal(save.patch.paragraphCache[helpers.transcriptTranslationCacheKey(track[0],"abcdefghijk")],"第一段的准确译文。");
});

test("late sidepanel translation cannot repaint or save under a newly selected video", async () => {
  let finish;
  const calls=[];
  const helpers = loadSidepanelHelpers({sendMessage: message => {
    calls.push(message);
    return new Promise(resolve => { finish = resolve; });
  }});
  const track=[{id:"segment-0-0",start:0,text:"Original paragraph."}];
  helpers.setTranscriptState({videoId:"abcdefghijk",transcript:track,mode:"bilingual"});
  const pending=helpers.requestTranscriptTranslationBatch([0],track,0,"abcdefghijk","bilingual");
  helpers.setTranscriptState({videoId:"lmnopqrstuv",transcript:track,mode:"bilingual"});
  finish({videoId:"abcdefghijk",segments:[{id:track[0].id,text:"旧视频的译文"}]});
  await pending;
  assert.equal(calls.length,1,"must not save an older result into the new video's cache");
});


test("preferred Japanese and Korean native tracks are requested without changing English fallback", async () => {
  for (const [preferred, expected, text] of [[undefined, "en", "Current English captions."], ["ja-JP", "ja", "日本語字幕です。"], ["ko-KR", "ko", "한국어 자막입니다."]]) {
    const background = loadBackgroundHelpers({
      settings: { supadataApiKey: "test-supadata" },
      fetchImpl: async (url, options) => {
        const request = new URL(url);
        assert.equal(request.searchParams.get("lang"), expected);
        assert.equal(request.searchParams.get("mode"), "native");
        assert.equal(request.searchParams.get("url"), "https://www.youtube.com/watch?v=1qOJvWakMz0");
        assert.equal(options.headers["x-api-key"], "test-supadata");
        return { status: 200, ok: true, json: async () => ({
          lang: expected, availableLangs: ["en", "ja", "ko"], content: [{ text, offset: 0, duration: 4000 }],
        }) };
      },
    });
    const result = await background.handleFetchTranscript("1qOJvWakMz0", { language: preferred });
    assert.equal(result.success, true);
    assert.equal(result.language, expected);
    assert.equal(result.requestedLanguage, expected);
    assert.deepEqual(JSON.parse(JSON.stringify(result.availableLanguages)), ["en", "ja", "ko"]);
    assert.equal(result.transcript[0].language, expected);
  }
});

test("Japanese or Korean fallback to another language is explicit failure, including async completion", async () => {
  for (const preferred of ["ja", "ko"]) {
    for (const asynchronous of [false, true]) {
      let calls = 0;
      const background = loadBackgroundHelpers({
        settings: { supadataApiKey: "test-supadata" },
        setTimeoutImpl(callback) { callback(); return 1; },
        fetchImpl: async () => {
          calls++;
          if (calls === 1 && asynchronous) return { status: 202, ok: true, json: async () => ({ jobId: "language-job" }) };
          return { status: 200, ok: true, json: async () => ({ status: "completed", lang: "en", availableLangs: ["en"], content: [{ text: "Fallback English subtitles.", offset: 0 }] }) };
        },
      });
      const result = await background.handleFetchTranscript("1qOJvWakMz0", { language: preferred });
      assert.equal(result.success, false);
      assert.equal(result.error, "TRANSCRIPT_LANGUAGE_UNAVAILABLE");
      assert.equal(result.requestedLanguage, preferred);
      assert.equal(result.language, "en");
      assert.equal(result.transcript, undefined, "Wrong-language caption text must not enter cache/display");
      assert.match(result.message, preferred === "ja" ? /日文/ : /韩文/);
    }
  }
});

test("caption response exposes normalized available languages and never invents unknown source language", () => {
  const { parseTranscriptResponse } = loadBackgroundHelpers();
  const result = parseTranscriptResponse({ lang: "ko-KR", availableLangs: ["en", "KO", "ko-KR", "ja", null], content: [{ text: "한국어 자막입니다.", offset: 0 }] }, { requestedLanguage: "ko" });
  assert.equal(result.language, "ko");
  assert.deepEqual(JSON.parse(JSON.stringify(result.availableLanguages)), ["en", "ko", "ja"]);
  const unknown = parseTranscriptResponse({ content: [{ text: "Unknown source language.", offset: 0 }] }, { requestedLanguage: "ja" });
  assert.equal(unknown.error, "TRANSCRIPT_LANGUAGE_UNAVAILABLE");
});

test("Japanese and Korean source echoes are not accepted as Chinese translations", () => {
  const { normalizeTranslatedSegmentBatch: normalize } = loadBackgroundHelpers();
  for (const source of ["カメラをもう一度起動しますか？", "카메라를 다시 켤까요?"]) {
    const input = [{ id: "p", text: source }];
    assert.ok(normalize({ segments: [{ id: "p", text: source }] }, input).segments[0].error);
    assert.equal(normalize({ segments: [{ id: "p", text: "要重新启动摄像头吗？" }] }, input).segments[0].text, "要重新启动摄像头吗？");
  }
});
