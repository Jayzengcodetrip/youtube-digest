/**
 * SIDE PANEL LOGIC
 *
 * Handles the UI for YouTube Digest: video detection, transcript analysis,
 * rendering results, and export features.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// ============================================================
// STATE
// ============================================================

let currentVideoId = null;
let currentVideoUrl = null;
let currentAnalysis = null;
let currentTranscript = null;
let currentTranscriptText = null; // Plain text (for display/export)
let currentTranscriptTimestamped = null; // With timestamps for AI analysis
let currentTranscriptLanguage = null;
let currentTrackKey = null;
let currentSourceLanguage = null;
let sourceLanguageChange = null;
let sourceLanguageReload = null;
let sourceTrackRecoveryVideoId = null;
let currentVideoTitle = "";
let currentChannelName = "";
let currentVideoDescription = "";
let currentVideoDuration = 0;
let isAnalysisLoading = false; // Track if analysis is in progress
let youtubeTabId = null; // Store the YouTube tab ID for reliable messaging
let errorAction = null;
let digestLoadGeneration = 0;
let tabLoadGeneration = 0;
let playbackReadGeneration = 0;
let transcriptViewGeneration = 0;
let panelInitialized = false;
let panelConfigStatus = null;
let pendingSubtitleIntent = null;
let latestSubtitleIntent = null;
const handledSubtitleIntents = new Set();

// --- Translation state ---
// The universal language control supports original content, Chinese, and an
// aligned bilingual view across Transcript, Overview, and Notes.
let currentTranscriptMode = "original";
const DISPLAY_LANGUAGE_MODE_KEY = "ytd_display_language_modes_by_video";
const DISPLAY_LANGUAGE_MODES = new Set(["original", "zh", "bilingual"]);
let translationGeneration = 0; // Invalidates responses from older UI modes/videos.
let translationWorkCount = 0;
let transcriptScrollObserver = null;
// Stable keys include the video, source mode, language, and semantic segment ID.
let transcriptParagraphCache = new Map();
let interfaceTranslationCache = new Map();
let interfaceTranslationInFlight = new Set();
let interfaceTranslationFailures = new Set();
let currentNotes = [];
let currentNotesFilterVideoId = null;
let notesLoadGeneration = 0;
let displayLanguageWrite = Promise.resolve();
const TRANSLATION_MESSAGE_TIMEOUT_MS = 130_000;
const TRANSLATION_BATCH_SIZE = 3;

// --- Transcript search state ---
// Matches point to visible marks in the active transcript language mode.
// Search navigation only scrolls the panel. It does not seek the video.
let transcriptSearchMatches = [];
let transcriptSearchIndex = -1;

/**
 * Prevent a stopped service worker or dead message channel from leaving the
 * transcript queue stuck forever. The underlying Chrome message cannot be
 * cancelled, so settled guards deliberately ignore any late response.
 */
function sendTranslationMessage(message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      callback(value);
    };

    timeoutId = setTimeout(() => {
      finish(
        reject,
        new Error(
          "Translation request timed out after 130 seconds. Please Retry.",
        ),
      );
    }, TRANSLATION_MESSAGE_TIMEOUT_MS);

    let messagePromise;
    try {
      messagePromise = chrome.runtime.sendMessage(message);
    } catch (error) {
      finish(reject, error);
      return;
    }

    Promise.resolve(messagePromise).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
  });
}

// --- Auto-scroll state (follow video playback in transcript) ---
let autoScrollEnabled = true; // True = scroll transcript to follow video playback
let autoScrollInterval = null; // setInterval ID for polling video time
let lastAutoScrollTime = 0; // Timestamp of last programmatic scroll (ignores scroll events within 1s)

// --- Transcript reading position state ---
// Session storage survives a side panel close but clears when Chrome closes.
const TRANSCRIPT_VIEW_STATE_KEY = "ytd_transcript_view_state";
let pendingTranscriptViewState = null;
let transcriptViewStateSaveTimer = null;
let isRestoringTranscriptView = false;
let selectionActionsController = null;
let lastTranscriptScrollTop = 0;

// ============================================================
// TRANSCRIPT GROUPING
// ============================================================

const {
  TRANSCRIPT_SEGMENT_LIMITS, normalizeCaptionText, splitOversizedThought,
  groupTranscriptEntries,
} = YTD_TRANSCRIPT_SEGMENTS;

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
  setTranscriptModeButtons("original");
  setupEventListeners();
  void initializePanelConnection();
});

let panelInitialization = null;
let panelDocumentMarker = null;
function initializePanelConnection() {
  if (panelInitialization) return panelInitialization;
  const work = async () => {
    panelInitialized = false;
    setPanelSwitchStatus("");
    showState("loading");
    updateLoading("正在连接逐字稿", "");
    try {
      // A native side panel may have no MessageSender.documentId. The
      // background resolves its live SIDE_PANEL context for this real window.
      // Chrome freezes MessageSender.url at document creation. A fragment
      // changed with history.replaceState would not reach the worker. Load a
      // unique document URL once so both sender.url and getContexts agree.
      const panelUrl = new URL(window.location.href);
      panelDocumentMarker = panelUrl.searchParams.get("ytd-panel");
      if (!/^[a-f0-9-]{36}$/.test(panelDocumentMarker || "")) {
        panelUrl.searchParams.set("ytd-panel", crypto.randomUUID());
        window.location.replace(panelUrl.href);
        return;
      }
      panelWindowReady = chrome.windows.getCurrent().then((w) => { panelWindowId = w.id; });
      await panelWindowReady;
      const ready = await chrome.runtime.sendMessage({
        action: "transcriptPanelReady", windowId: panelWindowId,
      });
      if (!ready?.success) throw new Error(ready?.error || "扩展后台暂时没有响应。");
      if (ready.intent) queueSubtitleIntent(ready.intent);
      await evictOldCacheEntries();
      panelConfigStatus = await chrome.runtime.sendMessage({ action: "checkConfig" });
      if (!panelConfigStatus) throw new Error("扩展后台暂时没有响应。");
      panelInitialized = true;
      if (pendingSubtitleIntent) {
        await applySubtitleIntent(pendingSubtitleIntent);
      } else if (!panelConfigStatus.hasSupadataKey || !panelConfigStatus.hasAiKey) {
        showConfigError(panelConfigStatus);
      } else {
        await checkCurrentTab();
      }
    } catch (error) {
      // Keep the failure visible and retryable instead of stranding the user
      // on Ready to Digest before video detection has even started.
      panelInitialized = false;
      const detail = String(error?.message || "扩展连接暂时中断。").slice(0, 240);
      showError("暂时无法打开逐字稿", `${detail} 请点击下方按钮重试。`);
      document.getElementById("errorBtn").textContent = "重试连接";
      errorAction = () => initializePanelConnection();
    }
  };
  panelInitialization = work().finally(() => { panelInitialization = null; });
  return panelInitialization;
}

// Listen for messages from the Digest button on YouTube page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "subtitleSourceChanged") {
    if (sender.id && sender.id !== chrome.runtime.id) return false;
    void handleSubtitleSourceChanged(message);
    return false;
  }
  if (message.action === "focusSubtitleTranscript") {
    if (sender.id && sender.id !== chrome.runtime.id) return false;
    void panelWindowReady.then(() => queueSubtitleIntent(message.intent)).catch(() => {});
    sendResponse({ success: true });
  }
  if (message.action === "startDigestFromButton") {
    if (message.windowId !== undefined && message.windowId !== panelWindowId) return false;
    if (pendingSubtitleIntent) return false;
    // Load the digest for the current video. Served from cache when we've
    // seen this video before (no API calls); fetched fresh otherwise.
    // (This used to force-clear the cache on every click, which silently
    // burned a transcript credit + analysis tokens per click.)
    checkCurrentTab();
    sendResponse({ success: true });
  }
  if (message.action === "transcriptProgress") {
    // Background is telling us the transcript fetch status changed
    updateLoading(message.title, message.subtitle);
    sendResponse({ success: true });
  }
  if (message.action === "noteSaved") {
    // Refresh notes list when a new note is saved
    const filterAll = document
      .getElementById("notesFilterAll")
      ?.classList.contains("active");
    loadNotes(filterAll ? null : currentVideoId);
    sendResponse({ success: true });
  }
  return false;
});

// ============================================================
// FOLLOW THE ACTIVE TAB
// ============================================================
// The panel watches which tab is in front of it and reacts:
//   - Front tab is NOT YouTube  -> the panel closes itself (window.close()).
//     We do this OURSELVES rather than relying only on the background
//     script's per-tab enable/disable, because Chrome doesn't reliably
//     apply per-tab panel state to tabs spawned in unusual ways (e.g. a
//     link opened from another app) — which let the panel linger on
//     non-YouTube pages.
//   - Front tab IS YouTube but on a different video -> refresh the digest.
//     YouTube is a single-page app (clicking a video swaps content without
//     a reload), so we track URL changes; startDigest() caches per video,
//     making re-checks instant and free for already-digested videos.
//
// Everything is scoped to the window this panel lives in: tab switches in
// OTHER browser windows must not close this panel or hijack its content.

let navigationRefreshTimer = null;
let panelWindowId = null;
let panelWindowReady = chrome.windows.getCurrent().then((w) => {
  panelWindowId = w.id;
});
// Initialization retries this lookup and presents any failure in the panel.
panelWindowReady.catch(() => {});

function scheduleDigestRefresh() {
  tabLoadGeneration += 1;
  digestLoadGeneration += 1;
  transcriptViewGeneration += 1;
  pendingSubtitleIntent = null;
  // Small delay lets YouTube finish rendering the new video's title and
  // description before we read them. Also collapses rapid-fire URL events
  // into a single refresh.
  clearTimeout(navigationRefreshTimer);
  navigationRefreshTimer = setTimeout(() => {
    checkCurrentTab();
  }, 600);
}

function panelIsShowingResults() {
  const results = document.getElementById("resultsState");
  return results && results.style.display !== "none";
}

/**
 * Reacts to the URL now in front of the panel: close on non-YouTube,
 * refresh the digest when the video changed.
 */
function handleFrontTabUrl(url, tabId = null) {
  if (!(url || "").startsWith("https://www.youtube.com")) {
    // Start the position save, then close in this same event callback. Chrome
    // does not reliably honor window.close() after an asynchronous wait.
    void saveCurrentTranscriptViewState();
    window.close();
    return;
  }

  const newVideoId = extractVideoId(url);
  // Refresh when the video changed, or when we're not currently showing
  // results (e.g. user went home, then clicked back into the same video).
  if (newVideoId !== currentVideoId || (Number.isInteger(tabId) && tabId !== youtubeTabId) || !panelIsShowingResults()) {
    scheduleDigestRefresh();
  }
}

/**
 * Gets the best URL from a tab update that can change the visible page.
 * The status events repeat the close request after Chrome commits the first
 * non-YouTube navigation, when an early URL event alone can be lost.
 */
function getNavigationUrl(changeInfo, tab) {
  if (changeInfo.url) return changeInfo.url;
  if (changeInfo.status !== "loading" && changeInfo.status !== "complete") {
    return "";
  }
  return tab.pendingUrl || tab.url || "";
}

// Fires when a tab starts or completes navigation, including YouTube's
// no-reload navigation. The completion event is a deliberate second close
// attempt for the first non-YouTube page.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab.active) return;
  if (panelWindowId !== null && tab.windowId !== panelWindowId) return;
  const url = getNavigationUrl(changeInfo, tab);
  if (!url) return;
  handleFrontTabUrl(url, tabId);
});

// Fires when a different tab comes to the front — switching tabs, or a new
// tab being opened (including ones opened by clicking links in other apps).
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (panelWindowId !== null && windowId !== panelWindowId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    // Brand-new tabs may not have committed their URL yet — fall back to
    // the pending one so we judge where the tab is actually going.
    if (tab.active === false) return;
    handleFrontTabUrl(tab.url || tab.pendingUrl || "", tabId);
  } catch (e) {
    // Tab closed before we could read it — nothing to do.
  }
});

function setupEventListeners() {
  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // Error retry
  document.getElementById("errorBtn").addEventListener("click", () => {
    if (errorAction) {
      errorAction();
      return;
    }
    if (currentVideoId) {
      startDigest(currentVideoId, currentVideoUrl, { retry: true });
    }
  });

  document.getElementById("returnToSubtitlesBtn")?.addEventListener("click", closeTranscriptPanel);
  document.getElementById("sourceLanguageSelect")?.addEventListener("change", (event) => {
    void handleSourceLanguageChange(event.target.value);
  });

  document.getElementById("settingsBtn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "openOptions" });
  });

  // Transcript actions
  document
    .getElementById("copyTranscriptBtn")
    ?.addEventListener("click", copyTranscript);
  document
    .getElementById("exportTranscriptBtn")
    ?.addEventListener("click", exportTranscript);
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    button.addEventListener("click", () => {
      handleDisplayLanguageModeChange(button.dataset.transcriptMode);
    });
  });
  setupTranscriptSearch();

  // pagehide also covers closing the side panel without a tab change.
  window.addEventListener("pagehide", () => {
    void saveCurrentTranscriptViewState();
  });

  // Follow playback button — re-enables auto-scroll after user scrolled away
  document
    .getElementById("followPlaybackBtn")
    ?.addEventListener("click", () => {
      autoScrollEnabled = true;
      document.getElementById("followPlaybackBtn").style.display = "none";
      // Jump straight back to the line currently being spoken. We scroll
      // directly (not via playbackTrackingTick) because the tick skips
      // entries that are already highlighted — and the current line almost
      // always IS highlighted, which made this button appear to do nothing.
      if (!scrollToActiveEntry()) {
        playbackTrackingTick(); // No highlight yet — let a tick establish one
      }
    });

  // Notes filter buttons
  document.getElementById("notesFilterThis")?.addEventListener("click", () => {
    setNotesFilter(false);
    loadNotes(currentVideoId);
  });
  document.getElementById("notesFilterAll")?.addEventListener("click", () => {
    setNotesFilter(true);
    loadNotes(null); // Load all notes
  });
}

function setNotesFilter(showAll) {
  const thisVideoButton = document.getElementById("notesFilterThis");
  const allNotesButton = document.getElementById("notesFilterAll");
  thisVideoButton?.classList.toggle("active", !showAll);
  thisVideoButton?.setAttribute("aria-pressed", String(!showAll));
  allNotesButton?.classList.toggle("active", showAll);
  allNotesButton?.setAttribute("aria-pressed", String(showAll));
}

// ============================================================
// VIDEO DETECTION
// ============================================================

async function checkCurrentTab({ subtitleIntent = null } = {}) {
  const generation = ++tabLoadGeneration;
  try {
    await panelWindowReady;
    const tabs = await chrome.tabs.query({
      active: true,
      windowId: panelWindowId,
    });
    const tab = tabs[0] || null;
    if (generation !== tabLoadGeneration) return false;
    if (subtitleIntent && (tab?.id !== subtitleIntent.tabId ||
        tab?.windowId !== subtitleIntent.windowId ||
        extractVideoId(tab?.url) !== subtitleIntent.videoId)) return false;
    if (!tab?.url) { showState("welcome"); return false; }
    if (!tab.url.startsWith("https://www.youtube.com")) {
      handleFrontTabUrl(tab.url);
      return;
    }
    youtubeTabId = tab.id;
    const videoId = extractVideoId(tab.url);
    if (!videoId) { showState("welcome"); return false; }
    currentVideoUrl = tab.url;
    let metadata = {};
    try {
      const result = await chrome.runtime.sendMessage({
        action: "relayToContent", tabId: tab.id, videoId, windowId: panelWindowId,
        payload: { action: "getVideoInfo" },
      });
      if (result.success && result.response) metadata = result.response;
    } catch (_) { /* The transcript can still load without optional metadata. */ }
    if (generation !== tabLoadGeneration) return false;
    currentVideoTitle = metadata.title || "";
    currentChannelName = metadata.channelName || "";
    currentVideoDescription = metadata.description || "";
    currentVideoDuration = metadata.duration || 0;
    await startDigest(videoId, tab.url, { focusPlayback: !!subtitleIntent });
    return generation === tabLoadGeneration;
  } catch (error) {
    if (generation !== tabLoadGeneration) return false;
    console.error("Tab check error:", error);
    showState("welcome");
    return false;
  }
}

function setPanelSwitchStatus(text) {
  const status = document.getElementById("panelSwitchStatus");
  if (status) { status.textContent = text; status.hidden = !text; }
}

function sourceLanguageStatusText(source) {
  if (!source) return "正在识别原文语言…";
  const names = { en: "英语", ja: "日语", ko: "韩语", zh: "中文" };
  const language = String(source.language || "").split(/[-_]/)[0];
  const name = names[language] || source.language || "未知语言";
  if (source.preference !== "auto") return `当前字幕：${name}`;
  if (!source.language || /unknown|ambiguous|fallback|undetermined|unconfirmed/.test(source.reason || "")) {
    return source.language ? `原声未确定 · 当前字幕：${name}` : "原声未确定，可手动选择";
  }
  return `自动识别：${name}`;
}

function updateSourceLanguageControl(source = currentSourceLanguage, error = "") {
  const control = document.getElementById("sourceLanguageControl");
  const select = document.getElementById("sourceLanguageSelect");
  const status = document.getElementById("sourceLanguageStatus");
  if (control) control.hidden = !currentVideoId;
  if (select) {
    select.value = source?.preference || "auto";
    select.disabled = !!sourceLanguageChange || !!sourceLanguageReload;
  }
  if (status) status.textContent = error || sourceLanguageStatusText(source);
}

function invalidateSourceLanguageWork() {
  ++digestLoadGeneration;
  ++translationGeneration;
  ++transcriptViewGeneration;
  ++playbackReadGeneration;
  transcriptScrollObserver?.disconnect();
  transcriptScrollObserver = null;
  activeTranslationQueue = null;
  pendingTranscriptViewState = null;
  isRestoringTranscriptView = false;
  document.getElementById("contentArea")?.classList.remove("restoring-transcript-view");
}

async function reloadSourceLanguageTranscript(videoId, tabId) {
  if (sourceLanguageReload?.videoId === videoId && sourceLanguageReload.tabId === tabId) return sourceLanguageReload.promise;
  const operation = { videoId, tabId, promise: null };
  sourceLanguageReload = operation;
  operation.promise = (async () => {
    invalidateSourceLanguageWork();
    const viewGeneration = transcriptViewGeneration;
    const isCurrent = () => currentVideoId === videoId && youtubeTabId === tabId && transcriptViewGeneration === viewGeneration;
    currentTranscriptMode = "bilingual";
    setTranscriptModeButtons("bilingual");
    await saveDisplayLanguageMode(videoId, "bilingual");
    if (!isCurrent()) return;
    await startDigest(videoId, currentVideoUrl, { focusPlayback: true, reload: true });
    if (!isCurrent() || !currentTranscript?.length) return;
    switchTab("transcript", { restorePosition: false, translate: false });
    const segments = getActiveTranscriptSegments();
    renderTranscriptModeRows(segments, "bilingual");
    if (!await waitForTranscriptViewport(isCurrent)) return;
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent", tabId, videoId, windowId: panelWindowId,
      payload: { action: "getCurrentTime" },
    });
    if (!isCurrent()) return;
    autoScrollEnabled = true;
    const follow = document.getElementById("followPlaybackBtn");
    if (follow) follow.style.display = "none";
    if (result?.success && Number.isFinite(result.response?.currentTime)) {
      const time = result.response.currentTime;
      highlightActiveEntry(time);
      scrollToActiveEntry("instant");
      const index = Math.max(0, segments.findLastIndex((segment) => segment.start <= time));
      void translateTranscript({ reuseRows: true, initialIndex: index });
    } else {
      setPanelSwitchStatus("原文语言已切换，暂时无法定位当前句。");
      void translateTranscript({ reuseRows: true });
    }
  })().catch((error) => {
    if (currentVideoId === videoId && youtubeTabId === tabId) {
      updateSourceLanguageControl(currentSourceLanguage, error.message || "语言切换失败，请重试。");
    }
  }).finally(() => {
    if (sourceLanguageReload === operation) sourceLanguageReload = null;
    updateSourceLanguageControl();
  });
  updateSourceLanguageControl();
  return operation.promise;
}

async function handleSourceLanguageChange(preference) {
  if (!["auto", "en", "ja", "ko"].includes(preference) || !currentVideoId || sourceLanguageChange) return;
  const operation = { videoId: currentVideoId, tabId: youtubeTabId };
  sourceLanguageChange = operation;
  sourceTrackRecoveryVideoId = null;
  invalidateSourceLanguageWork();
  updateSourceLanguageControl({ ...currentSourceLanguage, preference });
  let failure = "";
  try {
    const result = await chrome.runtime.sendMessage({
      action: "setSubtitleSourceLanguage", ...operation, preference,
    });
    if (currentVideoId !== operation.videoId || youtubeTabId !== operation.tabId) return;
    if (!result?.success) throw new Error(result?.message || result?.error || "语言切换失败，请重试。");
    currentSourceLanguage = result.sourceLanguage || result;
    await reloadSourceLanguageTranscript(operation.videoId, operation.tabId);
  } catch (error) {
    if (currentVideoId === operation.videoId && youtubeTabId === operation.tabId) failure = error.message || "语言切换失败，请重试。";
  } finally {
    if (sourceLanguageChange === operation) sourceLanguageChange = null;
    updateSourceLanguageControl(currentSourceLanguage, failure);
  }
}

async function handleSubtitleSourceChanged(message) {
  const videoId = currentVideoId, tabId = youtubeTabId;
  if (!videoId || message.videoId !== videoId || sourceLanguageChange?.videoId === videoId || sourceLanguageReload?.videoId === videoId) return;
  try {
    const result = await chrome.runtime.sendMessage({ action: "getSubtitleSourceLanguage", videoId, tabId });
    if (!result?.success || currentVideoId !== videoId || youtubeTabId !== tabId || sourceLanguageChange || sourceLanguageReload) return;
    const source = result.sourceLanguage || result;
    if (source && currentTrackKey && source.preference === currentSourceLanguage?.preference &&
        (!source.language || source.language === currentSourceLanguage?.language)) return;
    await reloadSourceLanguageTranscript(videoId, tabId);
  } catch (_) { /* A future explicit choice can retry without disrupting playback. */ }
}

function queueSubtitleIntent(intent) {
  if (!intent || intent.source !== "subtitle" || intent.windowId !== panelWindowId ||
      !Number.isInteger(intent.tabId) || !/^[a-zA-Z0-9_-]{11}$/.test(intent.videoId) ||
      !intent.requestId || handledSubtitleIntents.has(intent.requestId)) return;
  if (latestSubtitleIntent && Number(intent.createdAt) < Number(latestSubtitleIntent.createdAt)) return;
  latestSubtitleIntent = intent;
  pendingSubtitleIntent = intent;
  if (panelInitialized) void applySubtitleIntent(intent);
}

// A native side panel can execute its scripts while its viewport is still
// zero pixels wide. Wait for actual layout before computing the current row's
// scroll position; otherwise later expansion clamps an enormous scroll offset.
function waitForTranscriptViewport(isCurrent) {
  return new Promise((resolve) => {
    const area = document.getElementById("contentArea");
    if (!area) { resolve(false); return; }
    let frame = null;
    let previousSize = null;
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      if (frame !== null) cancelAnimationFrame(frame);
      clearTimeout(timeout);
      resolve(ready);
    };
    const timeout = setTimeout(() => finish(false), 5000);
    const check = () => {
      if (!isCurrent()) { finish(false); return; }
      const rect = area.getBoundingClientRect();
      const size = rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0
        ? `${rect.width}:${rect.height}` : null;
      if (size && size === previousSize) { finish(true); return; }
      previousSize = size;
      frame = requestAnimationFrame(check);
    };
    check();
  });
}

async function applySubtitleIntent(intent) {
  if (handledSubtitleIntents.has(intent.requestId)) return;
  handledSubtitleIntents.add(intent.requestId);
  clearTimeout(navigationRefreshTimer);
  ++tabLoadGeneration;
  ++digestLoadGeneration;
  const viewGeneration = ++transcriptViewGeneration;
  pendingTranscriptViewState = null;
  isRestoringTranscriptView = false;
  document.getElementById("contentArea")?.classList.remove("restoring-transcript-view");
  setPanelSwitchStatus("");
  const isCurrent = () => pendingSubtitleIntent?.requestId === intent.requestId &&
    viewGeneration === transcriptViewGeneration;
  try {
    youtubeTabId = intent.tabId;
    if (!panelConfigStatus?.hasSupadataKey || !panelConfigStatus?.hasAiKey) {
      showConfigError(panelConfigStatus || {});
      return;
    }
    const loaded = await checkCurrentTab({ subtitleIntent: intent });
    if (!loaded || !isCurrent() || currentVideoId !== intent.videoId || !currentTranscript?.length) return;
    translationGeneration += 1;
    transcriptScrollObserver?.disconnect();
    transcriptScrollObserver = null;
    currentTranscriptMode = "bilingual";
    setTranscriptModeButtons("bilingual");
    // Activate and render cached bilingual rows BEFORE asking for the current
    // time; fetching a transcript may have taken several seconds.
    switchTab("transcript", { restorePosition: false, translate: false });
    const segments = getActiveTranscriptSegments();
    renderTranscriptModeRows(segments, "bilingual");
    if (!await waitForTranscriptViewport(isCurrent)) {
      if (isCurrent()) setPanelSwitchStatus("面板尚未显示完整，请收起后重试。");
      return;
    }
    autoScrollEnabled = true;
    document.getElementById("followPlaybackBtn").style.display = "none";
    playbackReadGeneration += 1;
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent", tabId: intent.tabId, videoId: intent.videoId,
      windowId: intent.windowId, payload: { action: "getCurrentTime" },
    });
    if (!isCurrent() || currentVideoId !== intent.videoId || youtubeTabId !== intent.tabId) return;
    if (!result?.success || !Number.isFinite(result.response?.currentTime)) {
      setPanelSwitchStatus("暂时无法定位当前句。请收起后重试。");
      return;
    }
    const time = result.response.currentTime;
    highlightActiveEntry(time);
    scrollToActiveEntry("instant");
    const index = Math.max(0, segments.findLastIndex((segment) => segment.start <= time));
    // Reuse these rows so a translation render cannot erase the highlight.
    void translateTranscript({ reuseRows: true, initialIndex: index });
  } catch (_) {
    if (isCurrent()) setPanelSwitchStatus("展开逐字稿失败，请收起后重试。");
  } finally {
    if (pendingSubtitleIntent?.requestId === intent.requestId) {
      pendingSubtitleIntent = null;
      void chrome.runtime.sendMessage({ action: "ackTranscriptPanelIntent",
        windowId: intent.windowId, requestId: intent.requestId, videoId: intent.videoId });
    }
  }
}

async function closeTranscriptPanel() {
  const button = document.getElementById("returnToSubtitlesBtn");
  if (button?.disabled) return;
  if (button) button.disabled = true;
  setPanelSwitchStatus("");
  try {
    await panelWindowReady;
    const tabs = await chrome.tabs.query({ active: true, windowId: panelWindowId });
    const tab = tabs[0];
    const result = await chrome.runtime.sendMessage({ action: "closeTranscriptPanel",
      windowId: panelWindowId, tabId: tab?.id, videoId: extractVideoId(tab?.url) });
    if (!result?.success) throw new Error("close failed");
    ++tabLoadGeneration;
    ++digestLoadGeneration;
    ++transcriptViewGeneration;
    pendingSubtitleIntent = null;
  } catch (_) {
    setPanelSwitchStatus("暂时无法收起，请重试或点击面板右上角的关闭按钮。");
  } finally {
    if (button) button.disabled = false;
  }
}

function extractVideoId(url) {
  try {
    const urlObj = new URL(url);

    if (
      urlObj.hostname.includes("youtube.com") &&
      urlObj.searchParams.has("v")
    ) {
      return urlObj.searchParams.get("v");
    }

    if (urlObj.hostname === "youtu.be") {
      return urlObj.pathname.slice(1);
    }

    if (urlObj.pathname.startsWith("/embed/")) {
      return urlObj.pathname.split("/")[2];
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================
// DIGEST PIPELINE
// ============================================================

async function startDigest(videoId, videoUrl, { retry = false, focusPlayback = false, reload = false } = {}) {
  const loadGeneration = ++digestLoadGeneration;
  // Check if we already have this video loaded in memory
  if (!reload && !retry && !focusPlayback && videoId === currentVideoId && currentAnalysis) {
    showState("results");
    return;
  }

  const videoChanged = videoId !== currentVideoId;

  // Every video change invalidates observer work and in-flight translations.
  if (videoChanged) {
    sourceTrackRecoveryVideoId = null;
    translationGeneration += 1;
    if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
    transcriptScrollObserver = null;
    resetTranscriptSearch();
    lastTranscriptScrollTop = 0;
    const viewState = focusPlayback ? null : await loadTranscriptViewState(videoId);
    if (loadGeneration !== digestLoadGeneration) return;
    pendingTranscriptViewState = viewState;
    // An unseen video always starts in Original, so opening it never spends
    // translation tokens. A saved choice is restored only for this video.
    const mode = focusPlayback ? "bilingual" : await loadDisplayLanguageMode(videoId, { apply: false });
    if (loadGeneration !== digestLoadGeneration) return;
    currentTranscriptMode = mode;
    setTranscriptModeButtons(mode);
    document
      .getElementById("contentArea")
      ?.classList.toggle(
        "restoring-transcript-view",
        Boolean(pendingTranscriptViewState),
      );
  }

  // Resolve the selected source track before reading the per-video digest.
  // A legacy English digest must never bypass automatic Japanese/Korean selection.
  currentVideoId = videoId;
  currentVideoUrl = videoUrl;
  currentTranscript = null;
  currentTrackKey = null;
  currentAnalysis = null;
  currentTranscriptText = null;
  currentTranscriptTimestamped = null;
  if (videoChanged) currentSourceLanguage = null;
  updateSourceLanguageControl();
  showState("loading");
  updateLoading("Fetching transcript", "");
  let transcriptResult;
  let cached;
  try {
    transcriptResult = await fetchTranscriptForPanel(videoId, retry);
    if (loadGeneration !== digestLoadGeneration) return;
    cached = await loadFromCache(videoId, { transcriptResult });
  } catch (error) {
    if (loadGeneration !== digestLoadGeneration) return;
    showError(error.code === "NO_SUPADATA_KEY" ? "API key missing" : "No transcript found", error.message);
    updateSourceLanguageControl(currentSourceLanguage, error.message);
    return;
  }
  if (loadGeneration !== digestLoadGeneration) return;
  currentTrackKey = transcriptResult.trackKey || null;
  currentSourceLanguage = transcriptResult.sourceLanguage || null;
  updateSourceLanguageControl();
  if (cached) {
    debugLog("Loading from cache:", videoId);
    currentVideoId = videoId;
    currentVideoUrl = videoUrl;
    currentAnalysis = cached.analysis || null;
    currentTranscript = cached.transcript;
    currentTranscriptText = cached.transcriptText;
    currentTranscriptTimestamped = cached.transcriptTimestamped;
    currentTranscriptLanguage = cached.transcriptLanguage || null;
    isAnalysisLoading = false;
    if (!currentTranscript?.length) {
      showError(
        "No spoken transcript",
        "Only sound cues or empty pauses were found in these captions.",
      );
      return;
    }

    // Restore semantic-segment translations from persistent storage.
    if (cached.paragraphCache) {
      for (const [key, value] of Object.entries(cached.paragraphCache)) {
        transcriptParagraphCache.set(key, value);
      }
    }
    if (cached.interfaceCache) {
      for (const [key, value] of Object.entries(cached.interfaceCache)) {
        interfaceTranslationCache.set(key, value);
      }
    }

    if (currentVideoTitle || currentChannelName) {
      const videoInfo = document.getElementById("videoInfo");
      document.getElementById("videoTitle").textContent = currentVideoTitle;
      document.getElementById("videoChannel").textContent = currentChannelName;
      videoInfo.style.display = "block";
    }

    // Always render transcript first
    renderTranscript();

    // Render analysis if we have it cached
    if (currentAnalysis) {
      renderAnalysisResults(currentAnalysis);
      highlightMomentsOnPage(currentAnalysis.keyMoments);
    }

    showState("results");
    document.getElementById("tabsNav").style.display = "flex";
    restorePendingTranscriptViewState(videoId);

    // Load notes for this video
    loadNotes(videoId);

    // Setup explain feature
    setupExplainFeature();
    if (!focusPlayback && currentTranscriptMode !== "original") translateTranscript();
    return;
  }

  currentVideoId = videoId;
  currentVideoUrl = videoUrl;
  currentAnalysis = null;
  currentTranscript = null;
  currentTranscriptText = null;
  currentTranscriptTimestamped = null;
  currentTranscriptLanguage = null;
  isAnalysisLoading = false;

  if (currentVideoTitle || currentChannelName) {
    const videoInfo = document.getElementById("videoInfo");
    document.getElementById("videoTitle").textContent = currentVideoTitle;
    document.getElementById("videoChannel").textContent = currentChannelName;
    videoInfo.style.display = "block";
  }

  currentTranscript = transcriptResult.transcript;
  currentTranscriptText = transcriptResult.transcriptText;
  currentTranscriptTimestamped = transcriptResult.transcriptTextTimestamped;
  currentTranscriptLanguage = transcriptResult.language || null;

  // Render transcript immediately (no LLM needed)
  renderTranscript();
  showState("results");
  document.getElementById("tabsNav").style.display = "flex";
  restorePendingTranscriptViewState(videoId);

  // Load notes for this video
  loadNotes(videoId);

  // Setup explain feature for text selection
  setupExplainFeature();
  if (!focusPlayback && currentTranscriptMode !== "original") translateTranscript();

  // Save transcript to cache (without analysis)
  await saveToCache(videoId);

  // DON'T run LLM analysis automatically - wait for user to click Overview tab
  // This saves tokens when user just wants to see the transcript
}

async function fetchTranscriptForPanel(videoId, retry = false) {
  const result = await chrome.runtime.sendMessage({ action: "fetchTranscript", videoId, tabId: youtubeTabId, retry });
  if (!result?.success || !Array.isArray(result.transcript)) {
    const error = new Error(result?.error === "NO_SUPADATA_KEY"
      ? "Add your Supadata API key in YouTube Digest Settings."
      : result?.message || result?.error || "Transcript is temporarily unavailable. Please retry.");
    error.code = result?.error;
    throw error;
  }
  return result;
}

// ============================================================
// RENDERING
// ============================================================

function interfaceTranslationCacheKey(surface, id, text) {
  return `${currentVideoId || "none"}:zh:${surface}:${id}:${text}`;
}

function getInterfaceTranslation(surface, id, text) {
  return interfaceTranslationCache.get(
    interfaceTranslationCacheKey(surface, id, text),
  );
}

function renderLocalizedContent(text, surface, id) {
  const original = String(text || "");
  if (!original) return "";
  const cacheKey = interfaceTranslationCacheKey(surface, id, original);
  const translated = getInterfaceTranslation(surface, id, original);
  if (currentTranscriptMode === "original") return escapeHtml(original);

  const translation = translated
    ? escapeHtml(translated)
    : interfaceTranslationFailures.has(cacheKey)
      ? '<span class="translation-error">Translation unavailable.</span>'
      : '<span class="translation-pending">Translating...</span>';
  if (currentTranscriptMode === "bilingual") {
    return `<span class="localized-copy"><span class="localized-original">${escapeHtml(original)}</span><span class="localized-translation">${translation}</span></span>`;
  }
  return `<span class="localized-copy"><span class="localized-translation">${translation}</span></span>`;
}

function getLocalizedPlainText(text, surface, id) {
  const original = String(text || "");
  const translated = getInterfaceTranslation(surface, id, original);
  if (currentTranscriptMode === "zh") return translated || original;
  if (currentTranscriptMode === "bilingual" && translated) {
    return `${original}\n\n${translated}`;
  }
  return original;
}

async function translateInterfaceSegments(surface, segments, rerender) {
  if (currentTranscriptMode === "original" || !segments.length) return;
  const generation = translationGeneration;
  const videoId = currentVideoId;
  const missing = segments
    .filter((segment) => segment.text)
    .map((segment) => ({
      ...segment,
      cacheKey: interfaceTranslationCacheKey(
        surface,
        segment.id,
        segment.text,
      ),
    }))
    .filter(
      (segment) =>
        !interfaceTranslationCache.has(segment.cacheKey) &&
        !interfaceTranslationFailures.has(segment.cacheKey) &&
        !interfaceTranslationInFlight.has(segment.cacheKey),
    );
  if (!missing.length) return;

  missing.forEach((segment) => interfaceTranslationInFlight.add(segment.cacheKey));
  setTranslatingSpinner(true);
  try {
    for (
      let start = 0;
      start < missing.length;
      start += TRANSLATION_BATCH_SIZE
    ) {
      const batch = missing.slice(start, start + TRANSLATION_BATCH_SIZE);
      let result;
      try {
        result = await sendTranslationMessage({
          action: "translateContent",
          content: {
            segments: batch.map(({ id, text }) => ({ id, text })),
          },
          contentType: "interfaceBatch",
          targetLanguage: "zh",
          videoTitle: currentVideoTitle,
        });
      } catch (error) {
        console.error("[YouTube Digest] Interface batch error:", error);
        result = { success: false, error: error.message };
      }
      if (
        generation !== translationGeneration ||
        videoId !== currentVideoId ||
        currentTranscriptMode === "original"
      ) {
        return;
      }
      const aligned = alignTranslatedSegmentBatch(
        batch,
        result?.success ? result.translatedContent?.segments : [],
      );
      aligned.forEach((item, index) => {
        if (item.text) {
          interfaceTranslationCache.set(batch[index].cacheKey, item.text);
        } else {
          interfaceTranslationFailures.add(batch[index].cacheKey);
        }
      });
      // Match the Transcript UX: reveal and persist every small batch as soon
      // as it returns instead of waiting for the full Overview or Notes list.
      rerender();
      await updateCache();
    }
  } catch (error) {
    console.error("[YouTube Digest] Interface translation error:", error);
    missing.forEach((segment) =>
      interfaceTranslationFailures.add(segment.cacheKey),
    );
  } finally {
    missing.forEach((segment) => interfaceTranslationInFlight.delete(segment.cacheKey));
    setTranslatingSpinner(false);
  }
}

function getOverviewTranslationSegments() {
  if (!currentAnalysis) return [];
  const segments = [];
  (currentAnalysis.chapters || []).forEach((chapter, index) => {
    if (chapter.title) {
      segments.push({ id: `chapter-${index}-title`, text: chapter.title });
    }
    if (chapter.summary) {
      segments.push({ id: `chapter-${index}-summary`, text: chapter.summary });
    }
  });
  [...(currentAnalysis.keyQuotes || [])]
    .sort((a, b) => (a.timestampSeconds || 0) - (b.timestampSeconds || 0))
    .forEach((quote, index) => {
      if (quote.quote) segments.push({ id: `quote-${index}`, text: quote.quote });
    });
  return segments;
}

function translateOverviewContent() {
  return translateInterfaceSegments(
    "overview",
    getOverviewTranslationSegments(),
    () => {
      const contentArea = document.getElementById("contentArea");
      const scrollTop = contentArea?.scrollTop || 0;
      renderAnalysisResults(currentAnalysis);
      if (contentArea) contentArea.scrollTop = scrollTop;
    },
  );
}

function getNoteTranslationId(note, index) {
  const stablePart = String(note.id || note.createdAt || index)
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .slice(0, 96);
  return `note-${stablePart || index}`;
}

function translateNotesContent() {
  const segments = currentNotes.map((note, index) => ({
    id: getNoteTranslationId(note, index),
    text: note.text || "",
  }));
  return translateInterfaceSegments("notes", segments, () => {
    const contentArea = document.getElementById("contentArea");
    const scrollTop = contentArea?.scrollTop || 0;
    renderNotes(currentNotes, currentNotesFilterVideoId);
    if (contentArea) contentArea.scrollTop = scrollTop;
  });
}

/**
 * Renders the analysis results into the Overview tab.
 * Shows chapters and key quotes only.
 */
function renderAnalysisResults(analysis) {
  // Chapters
  const chapterList = document.getElementById("chapterList");
  chapterList.innerHTML = "";
  (analysis.chapters || []).forEach((chapter, index) => {
    const li = document.createElement("li");
    li.className = "chapter-item";
    li.dataset.seconds = chapter.timestampSeconds;
    li.innerHTML = `
      <span class="chapter-timestamp">${escapeHtml(chapter.timestamp)}</span>
      <div class="chapter-content">
        <span class="chapter-title">${renderLocalizedContent(chapter.title, "overview", `chapter-${index}-title`)}</span>
        <span class="chapter-summary">${renderLocalizedContent(chapter.summary || "", "overview", `chapter-${index}-summary`)}</span>
      </div>
    `;
    li.addEventListener("click", () => {
      debugLog(
        "[YouTube Digest Panel] Chapter clicked:",
        chapter.timestamp,
        chapter.timestampSeconds,
      );
      seekTo(chapter.timestampSeconds);
    });
    chapterList.appendChild(li);
  });

  // Quotes - sort by timestamp (chronological order)
  const quotesList = document.getElementById("quotesList");
  quotesList.innerHTML = "";
  const sortedQuotes = [...(analysis.keyQuotes || [])].sort(
    (a, b) => (a.timestampSeconds || 0) - (b.timestampSeconds || 0),
  );
  sortedQuotes.forEach((quote, index) => {
    const div = document.createElement("div");
    div.className = "quote-item";
    div.dataset.seconds = quote.timestampSeconds;
    div.innerHTML = `
      <div class="quote-text">${renderLocalizedContent(quote.quote, "overview", `quote-${index}`)}</div>
      <div class="quote-meta">
        <span class="quote-timestamp">${escapeHtml(quote.timestamp)}</span>
        <div class="quote-actions">
          <button class="quote-save-note-btn" title="Save this quote as a note">Note</button>
          <button class="quote-copy-btn" title="Copy this quote">Copy</button>
        </div>
      </div>
    `;
    div.addEventListener("click", () => {
      debugLog(
        "[YouTube Digest Panel] Quote clicked:",
        quote.timestamp,
        quote.timestampSeconds,
      );
      seekTo(quote.timestampSeconds);
    });

    const quoteCopyBtn = div.querySelector(".quote-copy-btn");
    quoteCopyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(
          getLocalizedPlainText(quote.quote, "overview", `quote-${index}`),
        );
        quoteCopyBtn.textContent = "Copied";
        setTimeout(() => {
          quoteCopyBtn.textContent = "Copy";
        }, 1500);
      } catch (err) {
        console.error("Copy failed:", err);
      }
    });

    const quoteSaveNoteBtn = div.querySelector(".quote-save-note-btn");
    quoteSaveNoteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await saveQuoteAsNote(quote, quoteSaveNoteBtn);
    });

    quotesList.appendChild(div);
  });

  if (
    currentTranscriptMode !== "original" &&
    resultTabIsActive("overview")
  ) {
    void translateOverviewContent();
  }
}

/**
 * Saves a key quote as a timestamped note.
 */
async function saveQuoteAsNote(quote, btn) {
  if (!currentVideoId) return;

  const originalText = btn.textContent;
  btn.textContent = "Saving...";
  btn.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: currentVideoId,
      timestamp: quote.timestampSeconds,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
    });

    if (result.success) {
      btn.textContent = "Saved";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
      // Refresh notes list if on Notes tab
      loadNotes(currentVideoId);
    } else {
      console.error("[YouTube Digest] Save quote as note failed:", result.error);
      btn.textContent = "Error";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
    }
  } catch (error) {
    console.error("[YouTube Digest] Save quote as note error:", error);
    btn.textContent = "Error";
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 1500);
  }
}

/**
 * Legacy function for backwards compatibility with cached data.
 * Renders both transcript and analysis.
 */
function renderResults(analysis) {
  renderAnalysisResults(analysis);

  renderTranscript();

  document.getElementById("tabsNav").style.display = "flex";

  // Setup explain feature for text selection
  setupExplainFeature();
}

/**
 * Returns true while the user has a range of text selected.
 * Transcript row clicks must not seek in that state: the click emitted after
 * selection mouseup belongs to the selection/explain interaction, not playback.
 */
function hasNonCollapsedTextSelection() {
  const selection = window.getSelection();
  return Boolean(
    selection && selection.rangeCount > 0 && !selection.isCollapsed,
  );
}

/**
 * Preserves normal row-click seeking while keeping text selection inert.
 */
function seekFromTranscriptEntryClick(event, seconds) {
  if (hasNonCollapsedTextSelection()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  seekTo(seconds);
}

function renderTranscript() {
  if (!currentTranscript) return;

  const transcriptList = document.getElementById("transcriptList");
  transcriptList.innerHTML = "";

  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();

  // Group entries using smart sentence-boundary + time-guardrail logic
  const grouped = groupTranscriptEntries(currentTranscript);

  grouped.forEach((group) => {
    const div = document.createElement("div");
    div.className = "transcript-entry";
    div.dataset.seconds = group.start;

    const minutes = Math.floor(group.start / 60);
    const seconds = Math.floor(group.start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      <span class="transcript-text">${renderSubtitleInlineMarkup(group.text)}</span>
    `;

    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, group.start),
    );
    transcriptList.appendChild(div);
  });

  // Reapply an active query after a language mode rerenders the transcript.
  refreshTranscriptSearch({ preserveIndex: false, scroll: false });

  // Start tracking video playback for auto-scroll
  startPlaybackTracking();
}

// ============================================================
// TRANSCRIPT SEARCH
// ============================================================

/**
 * Finds separate, case-insensitive literal matches. A literal search is
 * important here because punctuation such as "." must be treated as transcript
 * text, not as a regular expression command.
 */
function findLiteralTranscriptMatches(text, query) {
  const source = String(text || "");
  const needle = String(query || "").trim();
  if (!needle) return [];

  const escapedNeedle = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(escapedNeedle, "giu");
  const matches = [];
  for (const match of source.matchAll(matcher)) {
    matches.push({ start: match.index, end: match.index + match[0].length });
  }

  return matches;
}

/**
 * Removes old marks before a new search. Restoring plain text first prevents
 * nested marks when the user types one more letter into the search field.
 */
function clearTranscriptSearchHighlights() {
  document
    .querySelectorAll("#transcriptList mark.transcript-search-highlight")
    .forEach((mark) => {
      const parent = mark.parentNode;
      mark.replaceWith(document.createTextNode(mark.textContent || ""));
      parent?.normalize();
    });

  document
    .querySelectorAll("#transcriptList .transcript-entry.search-current")
    .forEach((row) => row.classList.remove("search-current"));
}

/**
 * Replaces matching parts of one text node with mark elements. We collect all
 * text nodes before changing the DOM, so each replacement is safe and stable.
 */
function markTranscriptTextNode(textNode, query) {
  const ranges = findLiteralTranscriptMatches(textNode.nodeValue, query);
  if (!ranges.length) return [];

  const fragment = document.createDocumentFragment();
  const marks = [];
  let cursor = 0;

  ranges.forEach(({ start, end }) => {
    if (start > cursor) {
      fragment.appendChild(
        document.createTextNode(textNode.nodeValue.slice(cursor, start)),
      );
    }

    const mark = document.createElement("mark");
    mark.className = "transcript-search-highlight";
    mark.textContent = textNode.nodeValue.slice(start, end);
    fragment.appendChild(mark);
    marks.push(mark);
    cursor = end;
  });

  if (cursor < textNode.nodeValue.length) {
    fragment.appendChild(
      document.createTextNode(textNode.nodeValue.slice(cursor)),
    );
  }

  textNode.parentNode.replaceChild(fragment, textNode);
  return marks;
}

/**
 * Updates the result count and navigation buttons from the current search
 * state. The live output gives the same information to screen reader users.
 */
function updateTranscriptSearchControls(query) {
  const count = document.getElementById("transcriptSearchCount");
  const previous = document.getElementById("transcriptSearchPrevBtn");
  const next = document.getElementById("transcriptSearchNextBtn");
  const hasMatches = transcriptSearchMatches.length > 0;

  if (count) {
    count.textContent = !query
      ? ""
      : hasMatches
        ? `${transcriptSearchIndex + 1} of ${transcriptSearchMatches.length}`
        : "No matches";
  }
  if (previous) previous.disabled = !hasMatches;
  if (next) next.disabled = !hasMatches;
}

/**
 * Shows which match is current. Search navigation pauses automatic transcript
 * following, so playback cannot pull the user away from the result they found.
 */
function revealCurrentTranscriptSearchMatch({ scroll = true } = {}) {
  transcriptSearchMatches.forEach((mark) => mark.classList.remove("current"));
  document
    .querySelectorAll("#transcriptList .transcript-entry.search-current")
    .forEach((row) => row.classList.remove("search-current"));

  const mark = transcriptSearchMatches[transcriptSearchIndex];
  if (!mark) return;

  mark.classList.add("current");
  mark.closest(".transcript-entry")?.classList.add("search-current");

  if (!scroll) return;
  if (autoScrollInterval) {
    autoScrollEnabled = false;
    document.getElementById("followPlaybackBtn").style.display = "block";
  }
  mark.scrollIntoView({ behavior: "smooth", block: "center" });
}

/**
 * Searches the transcript that is visible now. This means Original searches
 * source subtitles, Chinese searches translated text, and Bilingual searches
 * both columns. Translated rows call this again as their text arrives.
 */
function refreshTranscriptSearch({ preserveIndex = false, scroll = true } = {}) {
  const input = document.getElementById("transcriptSearchInput");
  const clearButton = document.getElementById("transcriptSearchClearBtn");
  const query = String(input?.value || "").trim();
  const previousIndex = transcriptSearchIndex;

  clearTranscriptSearchHighlights();
  transcriptSearchMatches = [];
  transcriptSearchIndex = -1;
  if (clearButton) clearButton.hidden = !input?.value;

  if (!query) {
    updateTranscriptSearchControls(query);
    return;
  }

  document
    .querySelectorAll("#transcriptList .transcript-entry")
    .forEach((row) => {
      const content = row.querySelector(".transcript-text, .transcript-copy");
      if (!content) return;

      const textNodes = [];
      const walker = document.createTreeWalker(
        content,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            const parent = node.parentElement;
            if (!node.nodeValue || parent?.closest("button")) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        },
      );
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      textNodes.forEach((node) => {
        transcriptSearchMatches.push(...markTranscriptTextNode(node, query));
      });
    });

  if (transcriptSearchMatches.length) {
    transcriptSearchIndex = preserveIndex
      ? Math.min(Math.max(previousIndex, 0), transcriptSearchMatches.length - 1)
      : 0;
    revealCurrentTranscriptSearchMatch({ scroll });
  }
  updateTranscriptSearchControls(query);
}

/**
 * Moves through results in a loop, like the browser's built-in Find control.
 */
function moveTranscriptSearch(direction) {
  if (!transcriptSearchMatches.length) return;
  transcriptSearchIndex =
    (transcriptSearchIndex + direction + transcriptSearchMatches.length) %
    transcriptSearchMatches.length;
  revealCurrentTranscriptSearchMatch();
  updateTranscriptSearchControls(
    document.getElementById("transcriptSearchInput")?.value.trim(),
  );
}

/**
 * Clears search when the user opens a different video. A query for the old
 * video is unlikely to help and can make the next transcript look empty.
 */
function resetTranscriptSearch({ focus = false } = {}) {
  const input = document.getElementById("transcriptSearchInput");
  if (input) input.value = "";
  refreshTranscriptSearch({ scroll: false });
  if (focus) input?.focus();
}

/**
 * Wires mouse and keyboard controls once when the side panel starts.
 */
function setupTranscriptSearch() {
  const input = document.getElementById("transcriptSearchInput");
  const clearButton = document.getElementById("transcriptSearchClearBtn");
  const previous = document.getElementById("transcriptSearchPrevBtn");
  const next = document.getElementById("transcriptSearchNextBtn");
  if (!input) return;

  input.addEventListener("input", () => refreshTranscriptSearch());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      moveTranscriptSearch(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape" && input.value) {
      event.preventDefault();
      resetTranscriptSearch({ focus: true });
    }
  });

  clearButton?.addEventListener("click", () => {
    resetTranscriptSearch({ focus: true });
  });
  previous?.addEventListener("click", () => moveTranscriptSearch(-1));
  next?.addEventListener("click", () => moveTranscriptSearch(1));
}

function getDisplayedTranscriptText() {
  if (currentTranscriptMode === "original") return currentTranscriptText || "";
  return getActiveTranscriptSegments()
    .map((segment) => {
      const translated = transcriptParagraphCache.get(
        transcriptTranslationCacheKey(segment),
      );
      if (currentTranscriptMode === "zh") return translated || segment.text;
      return translated ? `${segment.text}\n${translated}` : segment.text;
    })
    .join("\n\n");
}

function copyTranscript() {
  copyToClipboardWithFeedback(getDisplayedTranscriptText(), "copyTranscriptBtn");
}

function exportTranscript() {
  const transcriptContent = getDisplayedTranscriptText();
  const videoUrl = `https://youtube.com/watch?v=${currentVideoId}`;

  let exportText = "";
  exportText += `TRANSCRIPT\n`;
  exportText += `${"=".repeat(60)}\n\n`;
  exportText += `Title: ${currentVideoTitle || "Unknown"}\n`;
  exportText += `Channel: ${currentChannelName || "Unknown"}\n`;
  exportText += `URL: ${videoUrl}\n`;
  exportText += `\n${"—".repeat(60)}\n\n`;

  if (currentVideoDescription) {
    exportText += `DESCRIPTION:\n${currentVideoDescription}\n`;
    exportText += `\n${"—".repeat(60)}\n\n`;
  }

  exportText += `TRANSCRIPT:\n\n${transcriptContent}\n`;
  exportText += `\n${"—".repeat(60)}\n`;
  exportText += `Exported by YouTube Digest\n`;

  const filename = `${sanitizeFilename(currentVideoTitle)}-transcript.txt`;
  downloadTextFile(exportText, filename);
}

// ============================================================
// UI STATE MANAGEMENT
// ============================================================

function showState(state) {
  document.getElementById("welcomeState").style.display =
    state === "welcome" ? "flex" : "none";
  document.getElementById("loadingState").style.display =
    state === "loading" ? "block" : "none";
  document.getElementById("errorState").style.display =
    state === "error" ? "block" : "none";
  const uploadEl = document.getElementById("uploadState");
  if (uploadEl) uploadEl.style.display = "none"; // Upload state removed — always hidden
  document.getElementById("resultsState").style.display =
    state === "results" ? "block" : "none";

  // The tab bar only belongs on the results view. We toggle it HERE, in one
  // place, so it tracks the view automatically. Previously each caller had to
  // remember to re-show it after showState("results"), and one path forgot —
  // which is why the tabs could vanish when re-opening an already-analyzed video.
  document.getElementById("tabsNav").style.display =
    state === "results" ? "flex" : "none";
  document.getElementById("transcriptModeControl").style.display =
    state === "results" ? "inline-flex" : "none";

  if (state !== "results") {
    stopPlaybackTracking();
  }
}

function updateLoading(title, subtitle) {
  document.getElementById("loadingText").textContent = title;
  document.getElementById("loadingSubtext").textContent = subtitle;
}

function showError(title, message) {
  errorAction = null;
  showState("error");
  document.getElementById("errorTitle").textContent = title;
  document.getElementById("errorMessage").textContent = message;
  document.getElementById("errorBtn").textContent = "Try Again";
}

function showConfigError(configStatus) {
  const missingKeys = [];
  if (!configStatus.hasSupadataKey) missingKeys.push("Supadata");
  if (!configStatus.hasAiKey) missingKeys.push("AI provider");

  showState("error");
  document.getElementById("errorTitle").textContent = "API Keys Missing";
  document.getElementById("errorMessage").textContent =
    `Add your ${missingKeys.join(" and ")} API key${missingKeys.length === 1 ? "" : "s"} in YouTube Digest Settings.`;
  document.getElementById("errorBtn").textContent = "Open Settings";
  errorAction = () => chrome.runtime.sendMessage({ action: "openOptions" });
}

// ============================================================
// TAB SWITCHING
// ============================================================

function switchTab(tabName, { restorePosition = true, translate = true } = {}) {
  if (restorePosition) transcriptViewGeneration += 1;
  const viewGeneration = transcriptViewGeneration;
  // Capture the transcript position before another tab reuses the same scroll
  // area. Scrolling Overview or Notes must not replace this value.
  if (tabName !== "transcript" && transcriptTabIsActive()) {
    captureCurrentTranscriptScrollTop();
    dismissSelectionActions(true);
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tabName);
  });

  // Start/stop playback tracking based on which tab is active
  if (tabName === "transcript") {
    // Notes always opens at the top, so restore the independent transcript
    // reading position when the user returns here.
    if (restorePosition) requestAnimationFrame(() => {
      const contentArea = document.getElementById("contentArea");
      if (viewGeneration !== transcriptViewGeneration || !contentArea || !transcriptTabIsActive()) return;
      lastAutoScrollTime = Date.now();
      contentArea.scrollTop = lastTranscriptScrollTop;
    });
    startPlaybackTracking();
  } else {
    stopPlaybackTracking();
  }

  // Saved notes are stored newest first. Open Notes at the top so the note the
  // user just created is the first item they see.
  if (tabName === "notes") {
    requestAnimationFrame(() => {
      const contentArea = document.getElementById("contentArea");
      const notesPanelIsActive = document.querySelector(
        '.tab-panel[data-panel="notes"].active',
      );
      if (contentArea && notesPanelIsActive) contentArea.scrollTop = 0;
    });
  }

  // Translate only the visible tab. This prevents hidden surfaces from using
  // tokens or competing with the batch queue the user is waiting for.
  if (tabName === "overview") {
    if (!currentAnalysis && !isAnalysisLoading) {
      triggerAnalysis();
    } else if (currentAnalysis && currentTranscriptMode !== "original") {
      void translateOverviewContent();
    }
  } else if (
    tabName === "notes" &&
    currentTranscriptMode !== "original"
  ) {
    void translateNotesContent();
  } else if (
    tabName === "transcript" && translate &&
    currentTranscriptMode !== "original" &&
    !transcriptScrollObserver
  ) {
    void translateTranscript();
  }
}

/**
 * Triggers the LLM analysis (lazy-loaded when user clicks Overview or Quotes tab).
 * This saves tokens by not running analysis until needed.
 */
async function triggerAnalysis() {
  if (!currentTranscriptTimestamped || isAnalysisLoading || currentAnalysis)
    return;

  isAnalysisLoading = true;
  const analysisVideoId = currentVideoId;
  const analysisTrackKey = currentTrackKey;
  const analysisGeneration = digestLoadGeneration;
  const isCurrentAnalysis = () => currentVideoId === analysisVideoId && currentTrackKey === analysisTrackKey &&
    digestLoadGeneration === analysisGeneration;

  // Show loading indicators in the Overview tab
  const chapterList = document.getElementById("chapterList");
  const quotesList = document.getElementById("quotesList");

  if (chapterList)
    chapterList.innerHTML =
      '<li class="chapter-item" style="color: var(--text-muted); border: none;">Loading chapters...</li>';
  if (quotesList)
    quotesList.innerHTML =
      '<div class="quote-item" style="color: var(--text-muted); border-left-color: var(--border);">Loading quotes...</div>';

  try {
    const analysisResult = await chrome.runtime.sendMessage({
      action: "analyzeTranscript",
      transcriptText: currentTranscriptTimestamped,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      videoDescription: currentVideoDescription,
      videoDuration: currentVideoDuration,
    });

    if (!isCurrentAnalysis()) return;

    if (!analysisResult.success) {
      if (chapterList)
        chapterList.innerHTML = `<li class="chapter-item" style="color: var(--accent); border: none;">Analysis failed: ${escapeHtml(analysisResult.error || "Unknown error")}</li>`;
      isAnalysisLoading = false;
      return;
    }

    currentAnalysis = analysisResult.analysis;
    renderAnalysisResults(currentAnalysis);
    highlightMomentsOnPage(currentAnalysis.keyMoments);

    // Save to cache now that we have analysis
    await saveToCache(currentVideoId);
  } catch (error) {
    if (!isCurrentAnalysis()) return;
    console.error("[YouTube Digest Panel] Analysis error:", error);
    if (chapterList)
      chapterList.innerHTML = `<li class="chapter-item" style="color: var(--accent); border: none;">Error: ${escapeHtml(error.message)}</li>`;
  }

  if (isCurrentAnalysis()) isAnalysisLoading = false;
}

// ============================================================
// TIMESTAMP / SEEK
// ============================================================

async function seekTo(seconds) {
  debugLog("[YouTube Digest Panel] seekTo called with:", seconds);
  if (seconds === undefined || seconds === null) {
    debugLog("[YouTube Digest Panel] seekTo aborted - no seconds value");
    return;
  }

  const payload = {
    action: "seekTo",
    seconds: Number(seconds),
  };

  try {
    // Validate the bound window, tab and video before seeking. A direct send
    // can reach the next video during YouTube's navigation/refresh interval.
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent", tabId: youtubeTabId, videoId: currentVideoId, windowId: panelWindowId,
      payload,
    });
    debugLog("[YouTube Digest Panel] seekTo relay result:", result);
  } catch (error) {
    console.error("[YouTube Digest Panel] seekTo error:", error);
  }
}

/**
 * Plays a saved note at its timestamp.
 * - If the note belongs to the video currently open, we seek the player in place.
 * - If it belongs to a DIFFERENT video (e.g. viewing "All Notes"), seeking the
 *   current player would jump to the wrong content, so we open that video in a
 *   new tab at the right timestamp instead.
 */
function playNote(note) {
  if (note.videoId && note.videoId === currentVideoId) {
    seekTo(note.timestampSeconds);
  } else {
    // note.timestampedUrl already includes the &t=<seconds>s anchor
    chrome.tabs.create({ url: note.timestampedUrl });
  }
}

async function highlightMomentsOnPage(moments) {
  if (!moments || !moments.length) return;

  try {
    // Route through background script for reliable message passing
    await chrome.runtime.sendMessage({
      action: "relayToContent", tabId: youtubeTabId, videoId: currentVideoId, windowId: panelWindowId,
      payload: {
        action: "highlightMoments",
        moments: moments,
        videoDuration: currentVideoDuration,
      },
    });
  } catch (error) {
    console.error("Highlight error:", error);
  }
}

// ============================================================
// UTILITY
// ============================================================

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

/**
 * Renders the small subset of inline formatting commonly present in subtitle
 * tracks and model translations. Everything is escaped first; only exact,
 * attribute-free allowlisted tags are restored as markup afterwards.
 */
function renderSubtitleInlineMarkup(text) {
  return escapeHtml(text).replace(
    /&lt;(\/?)(i|em|b|strong|u)&gt;|&lt;br(?:\s*\/)?&gt;/gi,
    (_match, closing, tagName) =>
      tagName ? `<${closing}${tagName.toLowerCase()}>` : "<br>",
  );
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error("Copy failed:", error);
    return false;
  }
}

async function copyToClipboardWithFeedback(text, buttonId) {
  const btn = document.getElementById(buttonId);
  const original = btn.textContent;

  const success = await copyToClipboard(text);
  if (success) {
    btn.textContent = "Copied";
    setTimeout(() => {
      btn.textContent = original;
    }, 2000);
  }
}

function downloadTextFile(text, filename) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(str) {
  return (str || "untitled")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 50)
    .toLowerCase();
}

// ============================================================
// TEXT SELECTION ACTIONS
// ============================================================

/**
 * Hides actions that belong only to a live transcript selection. Clearing the
 * browser range also prevents the toolbar from returning on another tab.
 */
function dismissSelectionActions(clearSelection = false) {
  const tooltip = document.getElementById("explainTooltip");
  if (tooltip) tooltip.style.display = "none";
  if (clearSelection) window.getSelection()?.removeAllRanges();
}

/**
 * Sets up text selection handling in the transcript.
 * When the user selects text, shows Explain and Note actions.
 */
function setupExplainFeature() {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  // This setup can run again after a cached transcript render. Abort old
  // document listeners so one selection creates only one action toolbar.
  selectionActionsController?.abort();
  selectionActionsController = new AbortController();
  const selectionSignal = selectionActionsController.signal;

  // Remove existing tooltip if any
  const existingTooltip = document.getElementById("explainTooltip");
  if (existingTooltip) existingTooltip.remove();

  // Create one small toolbar for actions on the selected transcript text.
  const tooltip = document.createElement("div");
  tooltip.id = "explainTooltip";
  tooltip.className = "explain-tooltip";
  tooltip.setAttribute("role", "toolbar");
  tooltip.setAttribute("aria-label", "Selected transcript actions");
  tooltip.innerHTML = `
    <button class="explain-btn" type="button">Explain</button>
    <button class="selection-note-btn" type="button">Note</button>
  `;
  tooltip.style.display = "none";
  document.body.appendChild(tooltip);

  let selectedText = "";
  let selectedTimestamp = 0;

  // Interacting with either action must preserve the transcript selection and
  // stay isolated from document and row click behavior.
  tooltip.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  tooltip.addEventListener("mouseup", (event) => {
    event.stopPropagation();
  });
  tooltip.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  // Listen for text selection
  document.addEventListener(
    "mouseup",
    () => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() || "";
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;

      // Both ends must be inside the transcript. The first selected row
      // supplies the timestamp when the selection spans more than one row.
      const isInTranscript = Boolean(
        range &&
          transcriptList.contains(range.startContainer) &&
          transcriptList.contains(range.endContainer),
      );

      // Allow any selection length.
      if (text.length > 0 && isInTranscript) {
        selectedText = text;
        const startElement =
          range.startContainer.nodeType === 1
            ? range.startContainer
            : range.startContainer.parentElement;
        const selectedRow = startElement?.closest(".transcript-entry");
        const rowSeconds = Number(selectedRow?.dataset.seconds);
        selectedTimestamp = Number.isFinite(rowSeconds) ? rowSeconds : 0;

        // Set the final coordinates while the toolbar is still hidden. If it
        // becomes visible first, Chrome paints it at its default left edge for
        // one frame before moving it to the selection center.
        const rect = range.getBoundingClientRect();
        tooltip.style.top = `${rect.bottom + window.scrollY + 8}px`;
        tooltip.style.left = `${rect.left + rect.width / 2}px`;
        tooltip.style.display = "flex";
      } else {
        tooltip.style.display = "none";
      }
    },
    { signal: selectionSignal },
  );

  // Hide tooltip when clicking elsewhere
  document.addEventListener(
    "mousedown",
    (event) => {
      if (!tooltip.contains(event.target)) {
        tooltip.style.display = "none";
      }
    },
    { signal: selectionSignal },
  );

  // Handle explain button click
  tooltip
    .querySelector(".explain-btn")
    .addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedText) return;

      tooltip.style.display = "none";
      await showExplanation(selectedText);
    });

  // Save the exact selected words at the first selected transcript row. This
  // action does not move playback and does not ask the AI to rewrite the text.
  tooltip
    .querySelector(".selection-note-btn")
    .addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedText || !currentVideoId) return;

      const button = event.currentTarget;
      const originalText = button.textContent;
      button.textContent = "Saving...";
      button.disabled = true;

      try {
        const result = await chrome.runtime.sendMessage({
          action: "saveNote",
          videoId: currentVideoId,
          timestamp: selectedTimestamp,
          videoTitle: currentVideoTitle,
          channelName: currentChannelName,
          selectedText,
        });

        if (!result?.success) {
          throw new Error(result?.error || "Could not save note");
        }

        button.textContent = "Saved";
        loadNotes(currentVideoId);
        setTimeout(() => {
          tooltip.style.display = "none";
          button.textContent = originalText;
          button.disabled = false;
        }, 900);
      } catch (error) {
        console.error("[YouTube Digest] Save selected note error:", error);
        button.textContent = "Error";
        setTimeout(() => {
          button.textContent = originalText;
          button.disabled = false;
        }, 1500);
      }
    });
}

/**
 * Shows the explanation modal and fetches it from the configured AI provider.
 */
async function showExplanation(selectedText) {
  // Create modal
  const modal = document.createElement("div");
  modal.id = "explainModal";
  modal.className = "explain-modal-overlay";
  modal.innerHTML = `
    <div class="explain-modal">
      <div class="explain-modal-header">
        <div class="explain-modal-title">Explain</div>
        <button class="explain-modal-close" id="closeExplain">Close</button>
      </div>
      <div class="explain-selected-text">"${escapeHtml(selectedText.substring(0, 200))}${selectedText.length > 200 ? "..." : ""}"</div>
      <div class="explain-modal-content" id="explanationContent">
        <div class="explain-loading">
          <div class="loading-bar"></div>
          <span>Analyzing...</span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Close handlers
  document
    .getElementById("closeExplain")
    .addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  // Get some context around the selection from the transcript
  const transcriptContext = getTranscriptContext(selectedText);

  // Fetch explanation
  try {
    const result = await chrome.runtime.sendMessage({
      action: "explainSelection",
      selectedText: selectedText,
      transcriptContext: transcriptContext,
      videoTitle: currentVideoTitle,
    });

    const contentDiv = document.getElementById("explanationContent");
    if (result.success) {
      contentDiv.innerHTML = `<div class="explain-text">${escapeHtml(result.explanation).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</div>`;
    } else {
      contentDiv.innerHTML = `<div class="explain-error">Failed to get explanation: ${escapeHtml(result.error)}</div>`;
    }
  } catch (error) {
    const contentDiv = document.getElementById("explanationContent");
    contentDiv.innerHTML = `<div class="explain-error">Error: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Gets surrounding context from the transcript for the selected text.
 */
function getTranscriptContext(selectedText) {
  const fullText = currentTranscriptText || "";
  const index = fullText.indexOf(selectedText);

  if (index === -1) return "";

  // Get 200 chars before and after
  const start = Math.max(0, index - 200);
  const end = Math.min(fullText.length, index + selectedText.length + 200);

  return fullText.substring(start, end);
}

// ============================================================
// CACHING
// ============================================================

/**
 * Saves the current digest results to persistent local storage.
 * Results survive browser restarts — reopening the same video loads from cache
 * without consuming API tokens or Supadata calls.
 * Cache expires after 30 days. Oldest entries evicted when > 20 videos cached.
 */
async function saveToCache(videoId) {
  if (!videoId || videoId !== currentVideoId || !currentTranscript) return;

  try {
    // Persist semantic-segment translations for this video.
    const paragraphCacheForVideo = {};
    for (const [key, value] of transcriptParagraphCache.entries()) {
      if (key.startsWith(`${videoId}:`)) {
        paragraphCacheForVideo[key] = value;
      }
    }
    const interfaceCacheForVideo = {};
    for (const [key, value] of interfaceTranslationCache.entries()) {
      if (key.startsWith(`${videoId}:`)) {
        interfaceCacheForVideo[key] = value;
      }
    }

    const cacheData = {
      analysis: currentAnalysis, // May be null if not yet analyzed
      transcript: currentTranscript,
      transcriptText: currentTranscriptText,
      transcriptTimestamped: currentTranscriptTimestamped,
      transcriptLanguage: currentTranscriptLanguage,
      transcriptTrackKey: currentTrackKey,
      sourceLanguage: currentSourceLanguage,
      transcriptCleanupVersion: YTD_TRANSCRIPT_CLEANUP.VERSION,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      paragraphCache: paragraphCacheForVideo,
      interfaceCache: interfaceCacheForVideo,
      timestamp: Date.now(),
    };

    const saved = await chrome.runtime.sendMessage({
      action: "saveDigestCache", videoId, tabId: youtubeTabId, trackKey: currentTrackKey, patch: cacheData,
    });
    if (!saved?.success) throw new Error(saved?.error || "Cache save failed.");
    debugLog(
      "Saved to cache:",
      videoId,
      currentAnalysis ? "(with analysis)" : "(transcript only)",
    );

  } catch (error) {
    console.error("Cache save error:", error);
  }
}

/**
 * Keeps the cache from growing unbounded.
 * Removes the oldest entries when we exceed maxEntries videos.
 *
 * @param {number} maxEntries - Maximum number of cached videos to keep
 */
async function evictOldCacheEntries() {
  // The background serializes eviction with both player and panel cache writes.
  try {
    const result = await chrome.runtime.sendMessage({ action: "pruneDigestCache" });
    if (result?.error) throw new Error(result.error);
  } catch (error) {
    console.error("Cache eviction error:", error);
  }
}

/**
 * Loads digest results from persistent local storage.
 * Returns null if not cached or expired (30-day expiry).
 */
async function loadFromCache(videoId, { transcriptResult = null } = {}) {
  if (!videoId) return null;

  // Do not catch a selection/fetch failure and quietly reuse the wrong track.
  const resolved = transcriptResult || await fetchTranscriptForPanel(videoId);

  try {
    const result = await chrome.storage.local.get(`digest_${videoId}`);
    const cached = result[`digest_${videoId}`];

    if (!cached || cached.transcriptTrackKey !== resolved.trackKey) return null;

    // Cache expires after 30 days
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - cached.timestamp > THIRTY_DAYS) {
      return null; // The background expires records inside its serialized queue.
    }

    const cleaned = cleanCachedTranscript(cached, videoId);
    if (cached.transcriptCleanupVersion !== YTD_TRANSCRIPT_CLEANUP.VERSION) {
      // Reuse the fetched captions locally. No extra Supadata request, and no
      // changes to API keys, saved notes, overview, or the cache's expiry time.
      const saved = await chrome.runtime.sendMessage({
        action: "saveDigestCache", videoId, tabId: youtubeTabId, trackKey: resolved.trackKey, patch: cleaned, preserveTimestamp: true,
      });
      if (saved?.error) throw new Error(saved.error);
    }
    return cleaned;
  } catch (error) {
    console.error("Cache load error:", error);
    return null;
  }
}

function cleanCachedTranscript(cached, videoId) {
  const transcript = YTD_TRANSCRIPT_CLEANUP.cleanupEntries(cached.transcript);
  const prefix = `${videoId}:zh:clean${YTD_TRANSCRIPT_CLEANUP.VERSION}:semantic:`;
  const paragraphCache = {};
  for (const [key, value] of Object.entries(cached.paragraphCache || {})) {
    if (!key.startsWith(prefix) || typeof value !== "string") continue;
    const cleaned = YTD_TRANSCRIPT_CLEANUP.cleanText(value, "zh");
    if (cleaned) paragraphCache[key] = cleaned;
  }
  return {
    ...cached,
    transcript,
    transcriptText: transcript.map((entry) => entry.text).join(" "),
    transcriptTimestamped: transcript
      .map((entry) => {
        const minutes = Math.floor(entry.start / 60);
        const seconds = String(Math.floor(entry.start % 60)).padStart(2, "0");
        return `[${minutes}:${seconds}] ${entry.text}`;
      })
      .join("\n"),
    paragraphCache,
    transcriptCleanupVersion: YTD_TRANSCRIPT_CLEANUP.VERSION,
  };
}

/**
 * Updates the cache after enhance or translation operations.
 */
async function updateCache() {
  if (currentVideoId) {
    await saveToCache(currentVideoId);
  }
}

// ============================================================
// NOTES
// ============================================================

/**
 * Loads and renders notes from storage.
 * @param {string|null} videoId - Filter by video ID, or null for all notes
 */
async function loadNotes(videoId) {
  if (videoId && videoId !== currentVideoId) return;
  const generation = ++notesLoadGeneration;
  const requestedVideo = currentVideoId;
  const tabGeneration = tabLoadGeneration;
  try {
    const result = await chrome.runtime.sendMessage({
      action: "getNotes",
      videoId: videoId,
    });

    if (generation !== notesLoadGeneration || requestedVideo !== currentVideoId || tabGeneration !== tabLoadGeneration) return;
    if (result.success) {
      currentNotes = result.notes || [];
      currentNotesFilterVideoId = videoId;
      renderNotes(result.notes, videoId);
    }
  } catch (error) {
    console.error("[YouTube Digest Panel] Load notes error:", error);
  }
}

/**
 * Renders the notes list in the Notes tab.
 */
function renderNotes(notes, filteredVideoId) {
  const notesList = document.getElementById("notesList");
  const notesIntro = document.getElementById("notesIntro");

  if (!notesList) return;

  notesList.innerHTML = "";

  if (!notes || notes.length === 0) {
    notesIntro.style.display = "block";
    notesIntro.textContent = filteredVideoId
      ? "No notes for this video yet. Hover over the video and click Note to save."
      : "No notes saved yet. Hover over a video and click Note to save.";
    return;
  }

  notesIntro.style.display = "none";

  notes.forEach((note, index) => {
    const translationId = getNoteTranslationId(note, index);
    const noteEl = document.createElement("div");
    noteEl.className = "note-item";
    noteEl.innerHTML = `
      <div class="note-header">
        <span class="note-timestamp" data-url="${escapeHtml(note.timestampedUrl)}" data-seconds="${Number(note.timestampSeconds) || 0}">${escapeHtml(note.timestamp)}</span>
        ${!filteredVideoId ? `<span class="note-video-title">${escapeHtml(note.videoTitle)}</span>` : ""}
      </div>
      <div class="note-text">${renderLocalizedContent(note.text, "notes", translationId)}</div>
      <div class="note-actions">
        <button class="note-action-btn note-copy-text">Copy text</button>
        <button class="note-action-btn note-copy-link" data-url="${escapeHtml(note.timestampedUrl)}">Copy timestamp</button>
        <button class="note-action-btn note-play" data-seconds="${Number(note.timestampSeconds) || 0}">Play</button>
        <button class="note-delete" data-id="${escapeHtml(note.id)}" type="button" aria-label="Delete note" title="Delete note">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 6h18"></path>
            <path d="M8 6V4h8v2"></path>
            <path d="m19 6-1 14H6L5 6"></path>
            <path d="M10 11v5"></path>
            <path d="M14 11v5"></path>
          </svg>
        </button>
      </div>
    `;

    // Timestamp click - play from this point (in this tab or a new one)
    noteEl.querySelector(".note-timestamp").addEventListener("click", () => {
      playNote(note);
    });

    // Delete button
    noteEl
      .querySelector(".note-delete")
      .addEventListener("click", async (e) => {
        e.stopPropagation();
        await deleteNote(note.id);
        loadNotes(filteredVideoId);
      });

    // Copy text button — copies just the note's text
    noteEl
      .querySelector(".note-copy-text")
      .addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(
            getLocalizedPlainText(note.text, "notes", translationId),
          );
          const btn = noteEl.querySelector(".note-copy-text");
          btn.textContent = "Copied";
          setTimeout(() => {
            btn.textContent = "Copy text";
          }, 2000);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

    // Copy timestamp button — copies the timestamped YouTube link
    noteEl
      .querySelector(".note-copy-link")
      .addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(note.timestampedUrl);
          const btn = noteEl.querySelector(".note-copy-link");
          btn.textContent = "Copied";
          setTimeout(() => {
            btn.textContent = "Copy timestamp";
          }, 2000);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

    // Play button (in this tab if it's the current video, else a new tab)
    noteEl.querySelector(".note-play").addEventListener("click", () => {
      playNote(note);
    });

    notesList.appendChild(noteEl);
  });

  if (currentTranscriptMode !== "original" && resultTabIsActive("notes")) {
    void translateNotesContent();
  }
}

/**
 * Deletes a note by ID.
 */
async function deleteNote(noteId) {
  try {
    await chrome.runtime.sendMessage({
      action: "deleteNote",
      noteId: noteId,
    });
  } catch (error) {
    console.error("[YouTube Digest Panel] Delete note error:", error);
  }
}

// ============================================================
// AUTO-SCROLL — Follow video playback in transcript
// ============================================================
// While a video plays, the transcript automatically scrolls to show which
// 30-second chunk is currently being spoken. If the user manually scrolls
// (e.g., to read ahead), auto-scroll pauses and a "Follow playback" button
// appears so they can resume it. Highlight always stays active regardless.

/**
 * Starts polling the video's current time and highlighting/scrolling
 * to the matching transcript entry.
 */
function startPlaybackTracking() {
  if (!currentTranscript || !currentTranscript.length) return;

  // Don't restart if already tracking (preserves user's auto-scroll state)
  if (autoScrollInterval) return;

  const willRestoreReadingPosition =
    pendingTranscriptViewState?.videoId === currentVideoId;
  autoScrollEnabled = !willRestoreReadingPosition;
  document.getElementById("followPlaybackBtn").style.display =
    willRestoreReadingPosition ? "block" : "none";

  // Poll video time every 500ms
  autoScrollInterval = setInterval(() => playbackTrackingTick(), 500);

  // Listen for manual scrolls on the content area
  const contentArea = document.getElementById("contentArea");
  contentArea.removeEventListener("scroll", onContentAreaScroll);
  contentArea.addEventListener("scroll", onContentAreaScroll);
}

/**
 * Stops playback tracking entirely. Called when leaving transcript tab,
 * starting a new digest, or leaving results state.
 */
function stopPlaybackTracking() {
  if (autoScrollInterval) {
    clearInterval(autoScrollInterval);
    autoScrollInterval = null;
  }
  autoScrollEnabled = true; // Reset for next time
  lastAutoScrollTime = 0;
  document.getElementById("followPlaybackBtn").style.display = "none";

  // Remove active highlights
  document
    .querySelectorAll(".transcript-entry.active-playback")
    .forEach((el) => {
      el.classList.remove("active-playback");
    });
}

/**
 * One tick of the playback tracker. Gets current video time from the
 * YouTube tab and highlights + scrolls to the matching transcript entry.
 */
async function playbackTrackingTick() {
  if (pendingSubtitleIntent) return;
  const readGeneration = ++playbackReadGeneration;
  const viewGeneration = transcriptViewGeneration;
  const tabId = youtubeTabId, videoId = currentVideoId, generation = tabLoadGeneration;
  try {
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent", tabId, videoId, windowId: panelWindowId,
      payload: { action: "getCurrentTime" },
    });

    if (readGeneration !== playbackReadGeneration || viewGeneration !== transcriptViewGeneration ||
        generation !== tabLoadGeneration || tabId !== youtubeTabId || videoId !== currentVideoId ||
        !transcriptTabIsActive() || !result.success || !result.response) return;

    const currentTime = result.response.currentTime || 0;
    highlightActiveEntry(currentTime);
  } catch (error) {
    // Silently ignore — YouTube tab might be closed or navigated away
  }
}

/**
 * Scrolls the transcript to the entry currently being spoken (the one
 * carrying the active-playback highlight). Returns false if nothing is
 * highlighted yet. Stamps lastAutoScrollTime BEFORE scrolling so the scroll
 * events from our own smooth animation aren't mistaken for the user
 * scrolling away (which would re-disable auto-scroll immediately).
 */
function scrollToActiveEntry(behavior = "smooth") {
  const activeEntry = document.querySelector(
    "#transcriptList .transcript-entry.active-playback",
  );
  if (!activeEntry) return false;

  lastAutoScrollTime = Date.now();
  activeEntry.scrollIntoView({ behavior, block: "center" });
  return true;
}

/**
 * Finds the transcript entry matching the current playback time,
 * highlights it, and scrolls to it (if auto-scroll is enabled).
 *
 * @param {number} currentSeconds - Current video playback time in seconds
 */
function highlightActiveEntry(currentSeconds) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  const entries = transcriptList.querySelectorAll(".transcript-entry");
  if (entries.length === 0) return;

  // Find the entry whose time range contains the current playback time
  let activeEntry = null;
  entries.forEach((entry, index) => {
    const entrySeconds = parseInt(entry.dataset.seconds);
    const nextEntry = entries[index + 1];
    const nextSeconds = nextEntry
      ? parseInt(nextEntry.dataset.seconds)
      : Infinity;

    if (currentSeconds >= entrySeconds && currentSeconds < nextSeconds) {
      activeEntry = entry;
    }
  });

  if (!activeEntry) return;

  // Skip if this entry is already highlighted (no DOM thrashing)
  if (activeEntry.classList.contains("active-playback")) return;

  // Remove old highlight, add new one
  entries.forEach((e) => e.classList.remove("active-playback"));
  activeEntry.classList.add("active-playback");

  // Only scroll if auto-scroll is enabled
  if (autoScrollEnabled) {
    lastAutoScrollTime = Date.now();
    activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/**
 * Scroll event handler for the content area.
 * Detects manual scrolling and disables auto-scroll so the user
 * can read at their own pace without being yanked back.
 */
function onContentAreaScroll() {
  scheduleTranscriptViewStateSave();

  // Ignore scroll events within 1 second of a programmatic scroll
  // (smooth scroll animations can last longer than a simple boolean flag)
  if (Date.now() - lastAutoScrollTime < 1000) return;

  // User scrolled manually — disable auto-scroll and show the button
  if (autoScrollEnabled && autoScrollInterval) {
    autoScrollEnabled = false;
    document.getElementById("followPlaybackBtn").style.display = "block";
  }
}

/**
 * Uses session storage when it is available. Local storage is a safe fallback
 * for older test or browser environments that do not expose session storage.
 */
function getTranscriptViewStateStorage() {
  return chrome.storage.session || chrome.storage.local;
}

/**
 * Reads one video's last visible transcript position.
 */
async function loadTranscriptViewState(videoId) {
  if (!videoId) return null;
  try {
    const result = await getTranscriptViewStateStorage().get(
      TRANSCRIPT_VIEW_STATE_KEY,
    );
    const state = result?.[TRANSCRIPT_VIEW_STATE_KEY]?.[videoId];
    const scrollTop = Number(state?.scrollTop);
    if (!Number.isFinite(scrollTop) || scrollTop < 0) return null;
    return { videoId, scrollTop };
  } catch (error) {
    console.error("[YouTube Digest] Reading position load error:", error);
    return null;
  }
}

/**
 * Stores positions for a small recent set of videos. This prevents one value
 * from growing without a limit during a long Chrome session.
 */
async function saveTranscriptViewState(videoId, scrollTop) {
  if (!videoId || !Number.isFinite(scrollTop) || scrollTop < 0) return;
  try {
    const storage = getTranscriptViewStateStorage();
    const result = await storage.get(TRANSCRIPT_VIEW_STATE_KEY);
    const states = result?.[TRANSCRIPT_VIEW_STATE_KEY] || {};
    states[videoId] = { scrollTop, updatedAt: Date.now() };

    const recentStates = Object.fromEntries(
      Object.entries(states)
        .sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 20),
    );
    await storage.set({ [TRANSCRIPT_VIEW_STATE_KEY]: recentStates });
  } catch (error) {
    console.error("[YouTube Digest] Reading position save error:", error);
  }
}

/**
 * Saves the visible position after scrolling stops. Capturing the video ID and
 * position now prevents a later video change from writing the wrong state.
 */
function scheduleTranscriptViewStateSave() {
  if (
    isRestoringTranscriptView ||
    !currentVideoId ||
    !transcriptTabIsActive()
  ) {
    return;
  }
  const contentArea = document.getElementById("contentArea");
  if (!contentArea) return;

  const videoId = currentVideoId;
  const scrollTop = contentArea.scrollTop;
  lastTranscriptScrollTop = scrollTop;
  clearTimeout(transcriptViewStateSaveTimer);
  transcriptViewStateSaveTimer = setTimeout(() => {
    void saveTranscriptViewState(videoId, scrollTop);
  }, 150);
}

/**
 * Saves immediately before the panel closes.
 */
function saveCurrentTranscriptViewState() {
  clearTimeout(transcriptViewStateSaveTimer);
  const contentArea = document.getElementById("contentArea");
  if (!currentVideoId || !contentArea) return Promise.resolve();
  if (transcriptTabIsActive()) captureCurrentTranscriptScrollTop();
  return saveTranscriptViewState(currentVideoId, lastTranscriptScrollTop);
}

/**
 * Returns true only while the Transcript tab is the visible results panel.
 */
function transcriptTabIsActive() {
  return resultTabIsActive("transcript");
}

function resultTabIsActive(tabName) {
  return Boolean(
    document.querySelector(
      `.tab-panel[data-panel="${CSS.escape(tabName)}"].active`,
    ),
  );
}

/**
 * Copies the shared scroll area's current value into transcript-only state.
 */
function captureCurrentTranscriptScrollTop() {
  const contentArea = document.getElementById("contentArea");
  if (contentArea) lastTranscriptScrollTop = contentArea.scrollTop;
}

/**
 * Restores the saved position after the transcript becomes visible. Follow
 * Playback stays paused, so the next timer tick cannot move the panel again.
 */
function restorePendingTranscriptViewState(videoId) {
  const viewGeneration = transcriptViewGeneration;
  const state = pendingTranscriptViewState;
  pendingTranscriptViewState = null;
  const contentArea = document.getElementById("contentArea");
  if (!state || state.videoId !== videoId) {
    contentArea?.classList.remove("restoring-transcript-view");
    return;
  }

  requestAnimationFrame(() => {
    if (viewGeneration !== transcriptViewGeneration || currentVideoId !== videoId || !contentArea) {
      contentArea?.classList.remove("restoring-transcript-view");
      return;
    }

    isRestoringTranscriptView = true;
    lastAutoScrollTime = Date.now();
    autoScrollEnabled = false;
    contentArea.scrollTop = state.scrollTop;
    lastTranscriptScrollTop = state.scrollTop;
    document.getElementById("followPlaybackBtn").style.display = "block";
    contentArea.classList.remove("restoring-transcript-view");
    requestAnimationFrame(() => {
      isRestoringTranscriptView = false;
    });
  });
}

// ============================================================
// UNIVERSAL DISPLAY LANGUAGE — Original / Chinese / aligned bilingual
// ============================================================

async function loadDisplayLanguageMode(videoId, { apply = true } = {}) {
  let mode = "original";
  if (videoId) {
    try {
      const stored = await chrome.storage.local.get(DISPLAY_LANGUAGE_MODE_KEY);
      const saved = stored?.[DISPLAY_LANGUAGE_MODE_KEY]?.[videoId]?.mode;
      if (DISPLAY_LANGUAGE_MODES.has(saved)) mode = saved;
    } catch (_) { /* Default to the untranslated view if storage is unavailable. */ }
  }
  if (apply) {
    currentTranscriptMode = mode;
    setTranscriptModeButtons(mode);
  }
  return mode;
}

async function saveDisplayLanguageMode(videoId, mode) {
  if (!videoId || !DISPLAY_LANGUAGE_MODES.has(mode)) return;
  // Serialize this panel's rapid mode changes so a delayed older storage write
  // cannot replace the most recent choice or drop another video's preference.
  const write = displayLanguageWrite.catch(() => {}).then(async () => {
    const stored = await chrome.storage.local.get(DISPLAY_LANGUAGE_MODE_KEY);
    const modes = stored?.[DISPLAY_LANGUAGE_MODE_KEY] || {};
    modes[videoId] = { mode, updatedAt: Date.now() };
    const recentModes = Object.fromEntries(
      Object.entries(modes)
        .sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 50),
    );
    await chrome.storage.local.set({ [DISPLAY_LANGUAGE_MODE_KEY]: recentModes });
  });
  displayLanguageWrite = write;
  return write;
}

function getActiveTranscriptSegments() {
  return groupTranscriptEntries(currentTranscript || []);
}

function transcriptTranslationCacheKey(segment, videoId = currentVideoId) {
  // Source text is part of the identity: cleanup can change segment boundaries
  // while leaving an old timestamp/index ID unchanged.
  return YTD_TRANSCRIPT_SEGMENTS.cacheKey(segment, videoId);
}

function setTranscriptModeButtons(mode) {
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    const active = button.dataset.transcriptMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function handleDisplayLanguageModeChange(mode) {
  if (!DISPLAY_LANGUAGE_MODES.has(mode)) return;
  if (mode === currentTranscriptMode) return;

  currentTranscriptMode = mode;
  // Applying a display choice must not wait for storage: a late save from a
  // previous click/video must never render over the user's latest selection.
  void saveDisplayLanguageMode(currentVideoId, mode).catch((error) => {
    console.error("[YouTube Digest Panel] Display preference save error:", error);
  });
  if (mode !== "original") interfaceTranslationFailures.clear();
  translationGeneration += 1;
  translationWorkCount = 0;
  setTranslatingSpinner(false);
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
  transcriptScrollObserver = null;
  setTranscriptModeButtons(mode);
  const activeTabName =
    document.querySelector(".tab.active")?.dataset.tab || "transcript";

  if (mode === "original") {
    renderTranscript();
    if (currentAnalysis) renderAnalysisResults(currentAnalysis);
    if (currentNotes.length) renderNotes(currentNotes, currentNotesFilterVideoId);
    return;
  }

  if (currentAnalysis) {
    renderAnalysisResults(currentAnalysis);
  }
  if (currentNotes.length) {
    renderNotes(currentNotes, currentNotesFilterVideoId);
  }
  if (activeTabName === "overview" && currentAnalysis) {
    await translateOverviewContent();
  } else if (activeTabName === "notes" && currentNotes.length) {
    await translateNotesContent();
  } else if (activeTabName === "transcript") {
    await translateTranscript();
  }
}

function renderTranscriptSegmentContent(segment, mode, translated, error) {
  const original = renderSubtitleInlineMarkup(segment.text);
  translated = YTD_TRANSCRIPT_CLEANUP.cleanText(translated, "zh");
  let translationHtml = "";
  if (translated) {
    translationHtml = renderSubtitleInlineMarkup(translated);
  } else if (error) {
    translationHtml = `${escapeHtml(error)}<button class="translation-retry-btn" type="button">Retry</button>`;
  } else {
    translationHtml = "Waiting for translation…";
  }

  if (mode === "bilingual") {
    return `<span class="transcript-copy"><span class="transcript-original">${original}</span><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
  }

  return `<span class="transcript-copy"><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
}

function renderTranscriptModeRows(segments, mode) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return [];
  transcriptList.innerHTML = "";

  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();

  const rows = [];
  segments.forEach((segment, index) => {
    const div = document.createElement("div");
    const cached = transcriptParagraphCache.get(
      transcriptTranslationCacheKey(segment),
    );
    div.className = `transcript-entry ${cached ? "translated" : "translating"}`;
    div.dataset.seconds = segment.start;
    div.dataset.segmentId = segment.id;
    div.dataset.segmentIndex = index;

    const minutes = Math.floor(segment.start / 60);
    const seconds = Math.floor(segment.start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;
    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      ${renderTranscriptSegmentContent(segment, mode, cached, "")}
    `;
    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, segment.start),
    );
    transcriptList.appendChild(div);
    rows.push(div);
  });

  // Bilingual mode can find source text before each translation arrives.
  refreshTranscriptSearch({ preserveIndex: false, scroll: false });

  startPlaybackTracking();
  return rows;
}

/**
 * Rebuilds a provider response in source order. Unknown IDs are ignored and
 * missing IDs remain explicit errors, never positional guesses.
 */
function alignTranslatedSegmentBatch(sourceSegments, responseSegments) {
  const translatedById = new Map();
  if (Array.isArray(responseSegments)) {
    responseSegments.forEach((item) => {
      if (!item || typeof item.id !== "string" || typeof item.text !== "string")
        return;
      const text = item.text.trim();
      if (text && !translatedById.has(item.id)) {
        translatedById.set(item.id, text);
      }
    });
  }

  return sourceSegments.map((segment) => ({
    id: segment.id,
    text: translatedById.get(segment.id) || "",
    error: translatedById.has(segment.id) ? "" : "Translation unavailable.",
  }));
}

function updateTranslatedRow(segment, index, alignedItem, generation) {
  if (generation !== translationGeneration) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-id="${CSS.escape(segment.id)}"]`,
  );
  if (!row) return;

  if (alignedItem.text) {
    transcriptParagraphCache.set(
      transcriptTranslationCacheKey(segment),
      alignedItem.text,
    );
  }

  const copy = row.querySelector(".transcript-copy");
  if (copy) {
    copy.outerHTML = renderTranscriptSegmentContent(
      segment,
      currentTranscriptMode,
      alignedItem.text,
      alignedItem.error,
    );
  }
  row.classList.toggle("translated", !!alignedItem.text);
  row.classList.toggle("translating", false);
  row.classList.toggle("translation-failed", !alignedItem.text);

  const retry = row.querySelector(".translation-retry-btn");
  if (retry) {
    ["mousedown", "mouseup"].forEach((eventName) => {
      retry.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    });
    retry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      retryTranslationSegment(index, generation);
    });
  }
}

let activeTranslationQueue = null;

async function requestTranscriptTranslationBatch(
  indices,
  segments,
  generation,
  videoId,
  mode,
  retry = false,
) {
  const sourceBatch = indices.map((index) => segments[index]);
  const trackKey = currentTrackKey;
  const tabId = youtubeTabId;
  setTranslatingSpinner(true);
  try {
    const result = await sendTranslationMessage({
      action: "translateSubtitleSegments",
      videoId,
      tabId,
      trackKey,
      segmentIds: sourceBatch.map(({ id }) => id),
      retry,
    });

    const isStale =
      generation !== translationGeneration ||
      videoId !== currentVideoId ||
      trackKey !== currentTrackKey || tabId !== youtubeTabId ||
      mode !== currentTranscriptMode;
    if (isStale) return;

    if (result?.error === "SUBTITLE_TRACK_CHANGED") {
      if (sourceTrackRecoveryVideoId !== videoId) {
        sourceTrackRecoveryVideoId = videoId;
        void reloadSourceLanguageTranscript(videoId, tabId);
      } else {
        setPanelSwitchStatus("字幕语言发生变化，请重新选择原文语言后重试。");
      }
      return;
    }

    const responseSegments = Array.isArray(result?.segments) ? result.segments : [];
    if (!result?.error && responseSegments.some((entry) => !entry.error && entry.text)) sourceTrackRecoveryVideoId = null;
    const aligned = alignTranslatedSegmentBatch(sourceBatch, responseSegments);
    aligned.forEach((item, batchIndex) => {
      const returned = responseSegments.find((entry) => entry.id === item.id);
      if (result?.error || returned?.error) {
        item.error = result?.message || result?.error || returned.message || returned.error;
        item.text = "";
      }
      updateTranslatedRow(
        sourceBatch[batchIndex],
        indices[batchIndex],
        item,
        generation,
      );
    });
    refreshTranscriptSearch({ preserveIndex: true, scroll: false });
    await updateCache();
  } catch (error) {
    if (generation !== translationGeneration) return;
    sourceBatch.forEach((segment, batchIndex) => {
      updateTranslatedRow(
        segment,
        indices[batchIndex],
        { id: segment.id, text: "", error: error.message || "Translation failed." },
        generation,
      );
    });
    refreshTranscriptSearch({ preserveIndex: true, scroll: false });
  } finally {
    setTranslatingSpinner(false);
  }
}

function retryTranslationSegment(index, generation) {
  if (generation !== translationGeneration || !activeTranslationQueue) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-index="${index}"]`,
  );
  if (row) {
    row.classList.add("translating");
    row.classList.remove("translation-failed");
    const translation = row.querySelector(".transcript-translation");
    if (translation) {
      translation.className = "transcript-translation translation-pending";
      translation.textContent = "Retrying…";
    }
  }
  activeTranslationQueue.enqueue(index, true);
}

/**
 * Renders immediately, translates the first small batch, then observes the
 * remaining rows. Batches are sequential so the provider is never flooded.
 */
async function translateTranscript({ reuseRows = false, initialIndex = 0 } = {}) {
  const segments = getActiveTranscriptSegments();
  if (!segments.length || currentTranscriptMode === "original") return;

  const generation = translationGeneration;
  const videoId = currentVideoId;
  const mode = currentTranscriptMode;
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();

  const rows = reuseRows ? [...document.querySelectorAll("#transcriptList .transcript-entry")]
    : renderTranscriptModeRows(segments, mode);
  const queue = [];
  const queued = new Set();
  const retryIndices = new Set();
  let processing = false;

  const processNext = async () => {
    if (processing || queue.length === 0 || generation !== translationGeneration)
      return;
    processing = true;
    const indices = queue.splice(0, TRANSLATION_BATCH_SIZE);
    indices.forEach((index) => queued.delete(index));
    try {
      await requestTranscriptTranslationBatch(
        indices,
        segments,
        generation,
        videoId,
        mode,
        indices.some((index) => retryIndices.has(index)),
      );
    } finally {
      indices.forEach((index) => retryIndices.delete(index));
      processing = false;
      if (queue.length && generation === translationGeneration) processNext();
    }
  };

  const enqueue = (index, force = false) => {
    if (!Number.isInteger(index) || !segments[index]) return;
    const cached = transcriptParagraphCache.has(
      transcriptTranslationCacheKey(segments[index]),
    );
    if ((!force && cached) || queued.has(index)) return;
    queue.push(index);
    queued.add(index);
    if (force) retryIndices.add(index);
    // Let all entries reported in the same viewport turn collect before the
    // worker starts, producing one small contextual multi-segment request.
    Promise.resolve().then(processNext);
  };
  activeTranslationQueue = { enqueue };

  transcriptScrollObserver = new IntersectionObserver(
    (observerEntries) => {
      observerEntries
        .filter((entry) => entry.isIntersecting)
        .sort(
          (a, b) =>
            Number(a.target.dataset.segmentIndex) -
            Number(b.target.dataset.segmentIndex),
        )
        .forEach((entry) => enqueue(Number(entry.target.dataset.segmentIndex)));
    },
    {
      root: document.getElementById("contentArea"),
      rootMargin: "320px 0px",
      threshold: 0,
    },
  );

  rows.forEach((row, index) => {
    if (!row.classList.contains("translated")) transcriptScrollObserver.observe(row);
    if (index >= initialIndex && index < initialIndex + TRANSLATION_BATCH_SIZE) enqueue(index);
  });
}

function setTranslatingSpinner(show) {
  if (show) translationWorkCount += 1;
  else translationWorkCount = Math.max(0, translationWorkCount - 1);
  const isTranslating = translationWorkCount > 0;
  const spinner = document.getElementById("langSpinner");
  if (spinner) spinner.classList.toggle("visible", isTranslating);
}

// Pure helpers are exposed for the repository's Node tests. The extension does
// not read this object at runtime.
globalThis.__YTD_TRANSCRIPT_TESTING__ = {
  sourceLanguageStatusText,
  handleSourceLanguageChange,
  handleSubtitleSourceChanged,
  reloadSourceLanguageTranscript,
  cleanCachedTranscript,
  loadFromCache,
  transcriptTranslationCacheKey,
  getDisplayedTranscriptText,
  sendTranslationMessage,
  requestTranscriptTranslationBatch,
  saveToCache,
  startDigest,
  groupTranscriptEntries,
  splitOversizedThought,
  alignTranslatedSegmentBatch,
  findLiteralTranscriptMatches,
  loadTranscriptViewState,
  saveTranscriptViewState,
  loadDisplayLanguageMode,
  saveDisplayLanguageMode,
  getNavigationUrl,
  renderSubtitleInlineMarkup,
  renderTranscriptSegmentContent,
};
