/* YouTube Digest: player subtitles independent of the side panel. */
(function (root) {
  "use strict";

  const PLAYER_SELECTOR = "#movie_player.html5-video-player, #movie_player, .html5-video-player";
  const ACTIVE_CLASS = "ytd-video-subtitles-active";

  function watchVideoId(href) {
    try {
      const url = new URL(href);
      const id = url.searchParams.get("v") || "";
      return url.protocol === "https:" && url.hostname === "www.youtube.com" && url.pathname === "/watch" && /^[\w-]{11}$/.test(id) ? id : "";
    } catch (_) { return ""; }
  }

  function activeSegmentIndex(segments, time) {
    if (!Number.isFinite(time)) return -1;
    let low = 0;
    let high = segments.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (segments[middle].start <= time) {
        found = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    if (found < 0) return -1;
    const segment = segments[found];
    return Number.isFinite(segment.end) && time >= segment.end ? -1 : found;
  }

  function contextMenuPosition(playerRect, menuRect, point, viewport) {
    const inset = 8;
    // Account for a player partially outside the viewport, including a short
    // window with the lower player edge off-screen.
    const left = Math.max(inset, -playerRect.left + inset);
    const top = Math.max(inset, -playerRect.top + inset);
    const right = Math.min(playerRect.width, viewport.width - playerRect.left) - inset;
    const bottom = Math.min(playerRect.height, viewport.height - playerRect.top) - inset;
    return {
      left: Math.max(left, Math.min(point.x - playerRect.left, right - menuRect.width)),
      top: Math.max(top, Math.min(point.y - playerRect.top, bottom - menuRect.height)),
    };
  }

  function validTranslation(text) { return typeof text === "string" && text.trim().length > 0; }

  function displayText(text) {
    // Captions sometimes contain these formatting markers; they are text, not
    // page HTML. Preserve all other angle-bracket content literally.
    return String(text || "").replace(/<\/?(?:i|b|u)>/gi, "");
  }

  function suppressNativeCaptions(state) {
    // Keep native music/sound labels hidden during gaps in an enabled track.
    // Restore the native layer only for ads, disabled subtitles, or a track
    // that is unavailable altogether; a failed Chinese row still has original.
    return state.enabled && !state.advertising && !state.empty && (!state.error || Boolean(state.segment));
  }

  function requestWithTimeout(send, message, timers = globalThis, timeout = 130000) {
    return new Promise((resolve, reject) => {
      const timer = timers.setTimeout(() => reject(new Error("字幕请求已中断或超时，请重试。")), timeout);
      Promise.resolve().then(() => send(message)).then((response) => {
        timers.clearTimeout(timer);
        if (!response) reject(new Error("message channel closed"));
        else resolve(response);
      }, (error) => {
        timers.clearTimeout(timer);
        reject(error);
      });
    });
  }

  function errorText(error) {
    const text = typeof error === "string" ? error : error?.message;
    if (!text || /message port|receiving end|message channel|context invalidated|connection/i.test(text)) {
      return "扩展连接已中断，请重试；更新扩展后请刷新视频页面。";
    }
    return text.slice(0, 260);
  }

  // Panel actions are separate from subtitle preferences and playback. In
  // particular, send() is called in the click stack to retain Chrome's gesture.
  function createPanelController({ send, render, timers = globalThis, exitFullscreen = () => null, isVisible = () => true }) {
    let videoId = "";
    let epoch = 0;
    let revision = 0;
    let open = false;
    let pending = false;
    let error = "";
    let watchdog = null;
    let errorTimer = null;
    let errorRevision = 0;
    let noticeAction = 0;
    let dismissedAction = -1;
    const snapshot = () => ({ videoId, open, pending, error });
    const emit = () => render(snapshot());
    function clearError() {
      timers.clearTimeout(errorTimer);
      errorTimer = null;
      errorRevision += 1;
      error = "";
    }
    function dismissError() {
      // Late failures from this same click must not resurrect a dismissed toast.
      dismissedAction = noticeAction;
      clearError();
      emit();
    }
    function showError(message, action) {
      if (action !== noticeAction || action === dismissedAction) return;
      clearError();
      error = message;
      const expectedRevision = errorRevision;
      errorTimer = timers.setTimeout(() => {
        if (action !== noticeAction || expectedRevision !== errorRevision) return;
        dismissError();
      }, 3000);
      emit();
    }
    function invalidate() {
      epoch += 1;
      timers.clearTimeout(watchdog);
      watchdog = null;
      pending = false;
    }
    function refresh() {
      if (!videoId || !isVisible()) return;
      const expectedEpoch = epoch;
      const expectedRevision = revision;
      // A state query may take its ordinary async path; only toggle must be
      // synchronous with the originating user gesture.
      void requestWithTimeout(send, { action: "getTranscriptPanelState", videoId }, timers, 20000)
        .then((result) => {
          if (epoch !== expectedEpoch || revision !== expectedRevision || pending) return;
          if (result.error || typeof result.open !== "boolean") throw new Error(result.error || "未能读取逐字稿面板状态。");
          open = result.open;
          dismissedAction = noticeAction;
          clearError();
          emit();
        // Passive checks may race YouTube navigation. Keep the last confirmed
        // state without interrupting playback or starting an automatic retry loop.
        }).catch(() => {});
    }
    function toggle() {
      if (!videoId || pending) return;
      const expectedEpoch = ++epoch;
      const expectedRevision = ++revision;
      const action = ++noticeAction;
      pending = true;
      clearError();
      emit();
      watchdog = timers.setTimeout(() => {
        if (epoch !== expectedEpoch || !pending) return;
        // Invalidate a late response, but keep the current video for retry.
        invalidate();
        showError("逐字稿切换超时，请右键打开菜单后重试。", action);
        emit();
        refresh();
      }, 20000);
      function failed(failure) {
        if (epoch !== expectedEpoch) return;
        timers.clearTimeout(watchdog);
        watchdog = null;
        pending = false;
        showError(errorText(failure), action);
        emit();
      }
      try {
        if (!open) {
          const exiting = exitFullscreen();
          Promise.resolve(exiting).catch(() => {
            if (epoch !== expectedEpoch) return;
            showError("未能退出视频全屏，请按 Esc 后重试。", action);
          });
        }
      } catch (_) {
        // The panel can still be opened by this click; surface the exit issue.
        showError("未能退出视频全屏，请按 Esc 后重试。", action);
      }
      let result;
      try {
        // Do not move this into Promise.then or requestWithTimeout: sidePanel
        // open/close requires the runtime message to originate in this click.
        result = send({ action: "toggleTranscriptPanel", videoId, source: "subtitle", open: !open });
      } catch (failure) { failed(failure); return; }
      Promise.resolve(result).then((response) => {
        if (epoch !== expectedEpoch) return;
        if (response?.success !== true || typeof response.open !== "boolean") {
          throw new Error(response?.error || "未能切换逐字稿，请右键打开菜单后重试。");
        }
        timers.clearTimeout(watchdog);
        watchdog = null;
        pending = false;
        // Native onClosed/onOpened is newer truth, including a close that
        // occurs after open() resolves but before this response arrives.
        if (revision === expectedRevision) open = response.open;
        emit();
      }).catch(failed);
    }
    return {
      snapshot, refresh, toggle, dismissError,
      resetView() {
        invalidate();
        revision += 1;
        noticeAction += 1;
        clearError();
        emit();
      },
      setVideo(nextVideoId) {
        if (videoId === nextVideoId) return;
        invalidate();
        revision += 1;
        noticeAction += 1;
        videoId = nextVideoId;
        open = false;
        clearError();
        emit();
      },
      receive(message) {
        if (message?.action !== "transcriptPanelState" || !videoId || message.videoId !== videoId || typeof message.open !== "boolean") return;
        revision += 1;
        open = message.open;
        dismissedAction = noticeAction;
        clearError();
        emit();
      },
      destroy() { invalidate(); noticeAction += 1; videoId = ""; open = false; clearError(); emit(); },
    };
  }

  // This controller has no page or Chrome dependencies, so navigation, request
  // races, and prefetch decisions can be tested without making paid API calls.
  function createController({ request, render }) {
    let enabled = false;
    let videoId = "";
    let epoch = 0;
    let segments = [];
    let trackKey = "";
    let trackRecoveryUsed = false;
    let translations = Object.create(null);
    let errors = new Map();
    let pending = new Set();
    let loading = false;
    let loaded = false;
    let trackError = "";
    let translationError = "";
    let time = 0;
    let paused = true;
    let advertising = false;
    let lastSnapshot = "";
    let retryIds = new Set();

    function snapshot() {
      const index = activeSegmentIndex(segments, time);
      const segment = index < 0 ? null : segments[index];
      return {
        enabled, videoId, loading, advertising, paused, index,
        segment,
        translation: segment ? translations[segment.id] || "" : "",
        error: trackError || (segment && !validTranslation(translations[segment.id]) ? translationError || errors.get(segment.id) || "" : ""),
        empty: loaded && segments.length === 0,
      };
    }

    function emit() {
      const state = snapshot();
      const key = JSON.stringify(state);
      if (key !== lastSnapshot) {
        lastSnapshot = key;
        render(state);
      }
    }

    async function loadTrack(retry = false) {
      if (!enabled || !videoId || loading) return;
      const expectedEpoch = epoch;
      const expectedVideo = videoId;
      loading = true;
      trackError = "";
      emit();
      try {
        const result = await request({ action: "getSubtitleTrack", videoId, ...(retry ? { retry: true } : {}) });
        if (expectedEpoch !== epoch) return;
        if (result?.error) throw new Error(result.message || result.error);
        if (result?.videoId !== expectedVideo || !Array.isArray(result.segments)) throw new Error("字幕读取失败，请重试。");
        trackKey = result.trackKey || "";
        segments = result.segments.filter((segment) => segment && typeof segment.id === "string"
          && typeof segment.text === "string" && Number.isFinite(segment.start))
          .map((segment) => ({ id: segment.id, text: segment.text, start: segment.start, end: segment.end }));
        translations = Object.create(null);
        for (const segment of segments) {
          if (validTranslation(result.translations?.[segment.id])) translations[segment.id] = result.translations[segment.id];
        }
        loaded = true;
      } catch (error) {
        if (expectedEpoch === epoch) trackError = errorText(error);
      } finally {
        if (expectedEpoch === epoch) {
          loading = false;
          emit();
          pump();
        }
      }
    }

    function pump() {
      if (!enabled || !loaded || advertising || trackError || translationError) return;
      const index = activeSegmentIndex(segments, time);
      if (index < 0) return;
      const current = segments[index];
      let chosen;
      if (!validTranslation(translations[current.id])) {
        if (errors.has(current.id) || pending.has(current.id)) return;
        chosen = [current.id];
      } else {
        if (paused || pending.size) return;
        chosen = segments.slice(index + 1, index + 4)
          .filter((segment) => !validTranslation(translations[segment.id]) && !errors.has(segment.id))
          .map((segment) => segment.id);
      }
      if (!chosen.length) return;
      // A seek can prioritize the new current segment while an older batch
      // finishes. In-flight work is reused by the background service.
      if (pending.size >= 4) return;
      const expectedEpoch = epoch;
      const expectedVideo = videoId;
      const retry = chosen.some((id) => retryIds.has(id));
      chosen.forEach((id) => { pending.add(id); retryIds.delete(id); });
      void (async () => {
        try {
          const result = await request({ action: "translateSubtitleSegments", videoId: expectedVideo,
            segmentIds: chosen, ...(trackKey ? { trackKey } : {}), ...(retry ? { retry: true } : {}) });
          if (expectedEpoch !== epoch) return;
          if (result?.error === "SUBTITLE_TRACK_CHANGED" && !trackRecoveryUsed) {
            trackRecoveryUsed = true;
            reset();
            emit();
            void loadTrack();
            return;
          }
          if (result?.error) throw new Error(result.message || result.error);
          if (result?.videoId !== expectedVideo || !Array.isArray(result.segments)) throw new Error("翻译结果未能读取，请重试。");
          const rows = chosen.map((id) => result.segments.find((segment) => segment.id === id));
          if (rows.every((row) => row?.error || !validTranslation(row?.text))) {
            throw new Error(rows.find((row) => row?.error)?.error || "这一段暂时未能翻译，请重试。");
          }
          for (const id of chosen) {
            const translated = result.segments.find((segment) => segment.id === id);
            if (translated?.error || !validTranslation(translated?.text)) {
              errors.set(id, errorText(translated?.error || "这一段暂时未能翻译，请重试。"));
            } else translations[id] = translated.text;
          }
        } catch (error) {
          // A transport/configuration/service failure stops all new requests
          // until the viewer retries, including after playback advances.
          if (expectedEpoch === epoch) translationError = errorText(error);
        } finally {
          if (expectedEpoch === epoch) {
            chosen.forEach((id) => pending.delete(id));
            emit();
            pump();
          }
        }
      })();
    }

    function reset() {
      epoch += 1;
      segments = [];
      trackKey = "";
      translations = Object.create(null);
      errors = new Map();
      pending = new Set();
      retryIds = new Set();
      loading = false;
      loaded = false;
      trackError = "";
      translationError = "";
    }

    return {
      snapshot,
      setVideo(nextVideoId) {
        if (nextVideoId === videoId) return;
        trackRecoveryUsed = false;
        reset();
        videoId = nextVideoId;
        time = 0;
        paused = true;
        advertising = false;
        emit();
        if (enabled && videoId) void loadTrack();
      },
      reloadSource() {
        trackRecoveryUsed = false;
        reset();
        emit();
        if (enabled && videoId) void loadTrack();
      },
      setEnabled(nextEnabled) {
        if (enabled === Boolean(nextEnabled)) return;
        enabled = Boolean(nextEnabled);
        trackRecoveryUsed = false;
        reset();
        emit();
        if (enabled && videoId) void loadTrack();
      },
      tick(nextTime, nextPaused, nextAdvertising = false) {
        time = nextTime;
        paused = nextPaused;
        advertising = nextAdvertising;
        emit();
        pump();
      },
      retry() {
        if (!enabled) return;
        if (trackError) { void loadTrack(true); return; }
        const current = segments[activeSegmentIndex(segments, time)];
        if (current && (translationError || errors.has(current.id))) {
          translationError = "";
          errors.delete(current.id);
          retryIds.add(current.id);
          emit();
          pump();
        }
      },
      destroy() { enabled = false; reset(); videoId = ""; emit(); },
    };
  }

  const SHADOW_STYLE = `
    :host { position:absolute; inset:0; z-index:9998; pointer-events:none; font-family:system-ui,-apple-system,"Roboto",sans-serif; color:#fff; }
    *, *::before, *::after { box-sizing:border-box; }
    [hidden] { display:none !important; }
    button { font:600 13px/1.3 system-ui,-apple-system,sans-serif; cursor:pointer; pointer-events:auto; color:#fff; }
    button:focus-visible { outline:3px solid #fff; outline-offset:3px; }
    .toggle { position:absolute; top:16px; right:128px; border:1px solid rgba(255,255,255,.65); border-radius:999px; padding:9px 14px; background:rgba(24,24,24,.85); box-shadow:0 4px 14px rgba(0,0,0,.3); opacity:0; transition:opacity .18s,background .18s; pointer-events:none; white-space:nowrap; }
    .toggle[aria-pressed="true"] { background:#9a422d; border-color:#edb09b; }
    :host([controls-visible]) .toggle, .toggle:focus-visible { opacity:1; pointer-events:auto; }
    .toggle:disabled, .context-menu-item:disabled { cursor:wait; opacity:.65; }
    .context-menu { position:absolute; z-index:2; min-width:min(176px,calc(100% - 16px)); max-height:calc(100% - 16px); overflow:auto; max-width:calc(100% - 16px); padding:5px; border:1px solid rgba(255,255,255,.18); border-radius:10px; background:rgba(30,30,30,.98); box-shadow:0 5px 22px rgba(0,0,0,.4); pointer-events:auto; text-align:left; }
    .context-menu-item { display:flex; align-items:center; gap:9px; width:100%; min-height:38px; padding:9px 12px; border:0; border-radius:6px; background:transparent; white-space:nowrap; text-align:left; }
    .context-menu-item svg { width:17px; height:17px; flex:none; }
    .context-menu-item:hover, .context-menu-item:focus-visible { background:rgba(255,255,255,.13); }
    .source-control { display:block; padding:8px 12px; border-top:1px solid rgba(255,255,255,.12); font-size:12px; color:#ddd; }
    .source-control select { display:block; width:100%; margin-top:6px; padding:6px 8px; border:1px solid #666; border-radius:5px; background:#303030; color:white; font:inherit; pointer-events:auto; }
    .source-control select:focus-visible { outline:2px solid #edb09b; }
    .source-status { max-width:230px; font-size:11px; line-height:1.45; margin-top:6px; white-space:normal; }
    .context-menu-hint { padding:6px 12px 5px; border-top:1px solid rgba(255,255,255,.12); color:#bdbdbd; font-size:11px; line-height:1.4; white-space:normal; }
    .panel-error { position:absolute; z-index:1; top:65px; right:16px; display:flex; align-items:flex-start; gap:8px; max-width:min(calc(100% - 32px),420px); padding:9px 12px; border-radius:8px; background:rgba(43,23,17,.96); color:#fff; font-size:13px; line-height:1.5; text-shadow:0 1px 2px #000; pointer-events:auto; }
    .panel-error span { min-width:0; overflow-wrap:anywhere; }
    .panel-error button { flex:none; border:1px solid #edb09b; border-radius:5px; background:#7b321e; padding:4px 9px; }
    .panel-error .panel-dismiss { border-color:transparent; background:transparent; padding:2px 6px; font-size:19px; line-height:1.2; }
    .captions { position:absolute; bottom:76px; left:50%; transform:translateX(-50%); width:max-content; max-width:90%; padding:11px 18px; border-radius:8px; background:rgba(0,0,0,.78); text-align:center; text-shadow:0 1px 3px #000; line-height:1.4; overflow-wrap:anywhere; }
    .original { font-size:var(--original-size,20px); color:#f4f4f4; font-weight:500; white-space:pre-wrap; }
    .translation { font-size:var(--translation-size,23px); font-weight:600; white-space:pre-wrap; margin-top:6px; }
    .status { font-size:14px; line-height:1.5; color:#f2e3dc; margin-top:5px; }
    .actions { margin-top:8px; display:flex; justify-content:center; gap:10px; }
    .actions button { border:1px solid #d5b6aa; border-radius:999px; background:#7b321e; padding:6px 12px; }
  `;

  function install(window, document, chrome) {
    if (window.__YTD_SUBTITLE_OVERLAY__) window.__YTD_SUBTITLE_OVERLAY__.destroy();
    let destroyed = false;
    let player = null;
    let video = null;
    let view = null;
    let unbind = [];
    let reconcileTimer = null;
    let navigationTimer = null;
    let controlsTimer = null;
    let navigating = false;
    let preferenceError = "";
    let preferenceBusy = false;
    let preferenceRevision = 0;
    let enabled = false;
    let menuPoint = null;
    let menuPreviousFocus = null;
    let sourceRevision = 0;
    let sourceBusy = false;
    let sourceAction = 0;
    let sourceChangeCount = 0;

    const request = async (message) => {
      try {
        const response = await requestWithTimeout((payload) => chrome.runtime.sendMessage(payload), message, window);
        if (!response) throw new Error("message channel closed");
        return response;
      } catch (error) { throw new Error(errorText(error)); }
    };
    const controller = createController({ request, render: renderView });
    const panelController = createPanelController({
      send: (message) => chrome.runtime.sendMessage(message),
      render: renderPanelView,
      timers: window,
      exitFullscreen: () => document.fullscreenElement ? document.exitFullscreen() : null,
      isVisible: () => document.visibilityState !== "hidden",
    });

    function renderPanelView(state = panelController.snapshot()) {
      if (!view) return;
      const label = state.open ? "收起逐字稿" : "打开逐字稿";
      view.panelLabel.textContent = label;
      view.panelMenuItem.setAttribute("aria-label", label);
      view.panelMenuItem.title = state.pending ? "正在切换逐字稿…" : label;
      view.panelMenuItem.disabled = state.pending;
      view.panelError.hidden = !state.error;
      view.panelErrorText.textContent = state.error;
      view.panelRetry.disabled = state.pending;
      if (state.error) showControls();
      updateLayout();
    }

    function stopPlayerGesture(event) {
      event.preventDefault();
      event.stopPropagation();
    }

    function togglePanel(event) {
      stopPlayerGesture(event);
      if (event.button != null && event.button !== 0) return;
      hidePanelMenu();
      panelController.toggle();
    }

    function hidePanelMenu({ restoreFocus = false } = {}) {
      if (!view || view.contextMenu.hidden) return;
      view.contextMenu.hidden = true;
      menuPoint = null;
      if (restoreFocus && menuPreviousFocus?.isConnected) menuPreviousFocus.focus({ preventScroll: true });
      menuPreviousFocus = null;
    }

    function positionPanelMenu() {
      if (!view || !player || view.contextMenu.hidden || !menuPoint) return;
      const rect = player.getBoundingClientRect();
      const menuRect = view.contextMenu.getBoundingClientRect();
      const position = contextMenuPosition(rect, menuRect, menuPoint, {
        width: window.innerWidth, height: window.innerHeight,
      });
      view.contextMenu.style.left = `${position.left}px`;
      view.contextMenu.style.top = `${position.top}px`;
    }

    function showPanelMenu(event) {
      // Shift + right-click retains YouTube's existing menu. Use capture before
      // player handlers so normal right-click shows only our small menu.
      if (!view || !player || !event.composedPath().includes(player)) return;
      if (event.shiftKey) { hidePanelMenu(); return; }
      stopPlayerGesture(event);
      event.stopImmediatePropagation();
      const rect = player.getBoundingClientRect();
      menuPoint = { x: event.clientX || rect.left + rect.width / 2,
        y: event.clientY || rect.top + rect.height / 2 };
      menuPreviousFocus = view.shadow.activeElement || document.activeElement;
      view.contextMenu.hidden = false;
      renderPanelView();
      void loadSourceLanguage();
      positionPanelMenu();
      view.panelMenuItem.focus({ preventScroll: true });
    }

    function dismissPanelMenu(event) {
      if (!view?.contextMenu.hidden && !event.composedPath().includes(view.contextMenu)) hidePanelMenu();
    }

    function panelMenuKeydown(event) {
      if (!view || view.contextMenu.hidden) return;
      if (event.composedPath().includes(view.sourceSelect) && event.key !== "Escape") {
        event.stopPropagation();
        return;
      }
      if (event.key === "Escape") {
        stopPlayerGesture(event);
        event.stopImmediatePropagation();
        hidePanelMenu({ restoreFocus: true });
      } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        stopPlayerGesture(event);
        view.panelMenuItem.focus({ preventScroll: true });
      } else if (event.key !== "Tab") {
        // Let the button's native Enter/Space activation run without forwarding
        // keyboard shortcuts to YouTube while its menu item is focused.
        event.stopPropagation();
      }
    }

    function renderSourceLanguage(info) {
      if (!view) return;
      const names = { en: "英语", ja: "日语", ko: "韩语" };
      view.sourceSelect.value = info.preference || "auto";
      const name = names[info.language] || info.language || "未确定";
      view.sourceStatus.textContent = info.preference !== "auto" ? `本视频使用${name}原文`
        : info.reason === "fallback" || !info.language ? "原声未确定，默认英语；可手动选择"
        : `自动选择：${name}`;
      positionPanelMenu();
    }

    async function loadSourceLanguage() {
      if (sourceBusy) return;
      const id = watchVideoId(window.location.href);
      const revision = ++sourceRevision;
      if (!id || !view) return;
      view.sourceStatus.textContent = "正在读取字幕语言…";
      try {
        const info = await request({ action: "getSubtitleSourceLanguage", videoId: id });
        if (destroyed || revision !== sourceRevision || id !== watchVideoId(window.location.href)) return;
        if (info.error) throw new Error(info.message || info.error);
        renderSourceLanguage(info);
      } catch (error) {
        if (view && revision === sourceRevision) view.sourceStatus.textContent = errorText(error);
      }
    }

    async function changeSourceLanguage(event) {
      event.stopPropagation();
      if (sourceBusy) return;
      sourceBusy = true;
      const action = ++sourceAction;
      const id = watchVideoId(window.location.href);
      const preference = event.target.value;
      const revision = ++sourceRevision;
      const changes = sourceChangeCount;
      view.sourceSelect.disabled = true;
      view.sourceStatus.textContent = "正在切换字幕语言…";
      try {
        const result = await request({ action: "setSubtitleSourceLanguage", videoId: id, preference });
        if (destroyed || revision !== sourceRevision || id !== watchVideoId(window.location.href)) return;
        if (result.error) throw new Error(result.message || result.error);
        if (changes === sourceChangeCount) controller.reloadSource();
        renderSourceLanguage(result);
      } catch (error) {
        if (view && revision === sourceRevision) view.sourceStatus.textContent = errorText(error);
      } finally {
        if (action === sourceAction) {
          sourceBusy = false;
          if (view) view.sourceSelect.disabled = false;
        }
      }
    }

    function setClass(element, name, value) {
      if (element.classList.contains(name) !== value) element.classList.toggle(name, value);
    }

    function updateLayout() {
      if (!view || !player) return;
      const rect = player.getBoundingClientRect();
      const note = player.querySelector("#ytd-note-button");
      const noteWidth = note?.getBoundingClientRect().width || 96;
      view.toggle.style.right = `${Math.round(noteWidth + 24)}px`;
      const controls = player.querySelector(".ytp-chrome-bottom");
      const controlsRect = controls?.getBoundingClientRect();
      const hidden = player.classList.contains("ytp-autohide") || (controls && window.getComputedStyle(controls).opacity === "0");
      const clearance = !hidden && controlsRect?.height ? Math.max(64, rect.bottom - controlsRect.top + 14) : 24;
      view.captions.style.bottom = `${Math.round(clearance)}px`;
      let originalSize = Math.min(24, Math.max(14, rect.width / 54));
      let translatedSize = Math.min(28, Math.max(16, rect.width / 48));
      view.host.style.setProperty("--original-size", `${originalSize}px`);
      view.host.style.setProperty("--translation-size", `${translatedSize}px`);
      // Keep long paragraphs complete while leaving most of the picture visible.
      const height = view.captions.getBoundingClientRect().height;
      if (height > rect.height * 0.45 && rect.height > 0) {
        const scale = rect.height * 0.45 / height;
        originalSize = Math.max(12, originalSize * scale);
        translatedSize = Math.max(14, translatedSize * scale);
        view.host.style.setProperty("--original-size", `${originalSize}px`);
        view.host.style.setProperty("--translation-size", `${translatedSize}px`);
      }
      positionPanelMenu();
    }

    function renderView(state = controller.snapshot()) {
      if (!view || !player) return;
      view.toggle.textContent = preferenceError ? "双语字幕 · 重试" : enabled ? "双语字幕 · 开" : "双语字幕";
      view.toggle.setAttribute("aria-pressed", String(enabled));
      view.toggle.disabled = preferenceBusy;
      view.toggle.title = preferenceError || "在视频画面内显示原文和中文；会记住开关状态";
      const visible = state.enabled && !state.advertising;
      setClass(player, ACTIVE_CLASS, suppressNativeCaptions(state));
      view.captions.hidden = !visible || (!state.segment && !state.loading && !state.error && !state.empty);
      view.original.textContent = displayText(state.segment?.text);
      view.original.hidden = !state.segment;
      view.translation.textContent = displayText(state.translation);
      view.translation.hidden = !state.translation;
      view.status.textContent = state.error ? `字幕暂不可用：${state.error}` : state.loading ? "正在读取视频字幕…"
        : state.empty ? "这个视频暂时没有可用的逐字稿。" : state.segment && !state.translation ? "翻译中…" : "";
      view.status.hidden = !view.status.textContent;
      view.actions.hidden = !state.error;
      updateLayout();
    }

    function showControls() {
      if (!view) return;
      view.host.setAttribute("controls-visible", "");
      window.clearTimeout(controlsTimer);
      controlsTimer = window.setTimeout(() => {
        // A mouse click also focuses a button. Do not let that focus pin the
        // controls forever; keyboard focus remains visible through :focus-visible.
        if (view) view.host.removeAttribute("controls-visible");
      }, 2500);
    }

    function tick() {
      if (video && player) controller.tick(video.currentTime, video.paused || video.ended, player.classList.contains("ad-showing"));
    }

    async function loadPreference() {
      const revision = ++preferenceRevision;
      try {
        const result = await request({ action: "getSubtitlePreference" });
        if (destroyed || revision !== preferenceRevision) return;
        if (result.error) throw new Error(result.message || result.error);
        applyPreference(Boolean(result.enabled));
      } catch (error) {
        if (!destroyed && revision === preferenceRevision) {
          preferenceError = errorText(error);
          showControls();
          renderView();
        }
      }
    }

    function applyPreference(value) {
      enabled = value;
      preferenceError = "";
      controller.setEnabled(value);
      tick();
      renderView();
    }

    async function togglePreference(event) {
      event.preventDefault();
      event.stopPropagation();
      if (preferenceBusy) return;
      if (preferenceError) { preferenceError = ""; await loadPreference(); return; }
      const revision = ++preferenceRevision;
      preferenceBusy = true;
      renderView();
      try {
        const result = await request({ action: "setSubtitlePreference", enabled: !enabled });
        if (destroyed) return;
        if (result.error) throw new Error(result.message || result.error);
        if (revision === preferenceRevision) applyPreference(Boolean(result.enabled));
      } catch (error) {
        if (!destroyed && revision === preferenceRevision) preferenceError = errorText(error);
      } finally {
        preferenceBusy = false;
        renderView();
        showControls();
      }
    }

    function detach() {
      hidePanelMenu();
      sourceRevision += 1;
      sourceAction += 1;
      sourceBusy = false;
      panelController.resetView();
      for (const stop of unbind) stop();
      unbind = [];
      window.clearTimeout(controlsTimer);
      if (player) setClass(player, ACTIVE_CLASS, false);
      view?.host.remove();
      view?.nativeStyle.remove();
      view = null;
      player = null;
      video = null;
    }

    function attach(nextPlayer, nextVideo) {
      player = nextPlayer;
      video = nextVideo;
      const host = document.createElement("div");
      host.id = "ytd-subtitle-overlay";
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = SHADOW_STYLE;
      shadow.appendChild(style);
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "toggle";
      toggle.addEventListener("click", togglePreference);
      shadow.appendChild(toggle);
      function panelIcon(button) {
        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("viewBox", "0 0 24 24");
        icon.setAttribute("aria-hidden", "true");
        const outline = document.createElementNS("http://www.w3.org/2000/svg", "path");
        outline.setAttribute("d", "M4 4h16v16H4z M15 4v16 M18 8h0 M18 12h0 M18 16h0");
        outline.setAttribute("fill", "none");
        outline.setAttribute("stroke", "currentColor");
        outline.setAttribute("stroke-width", "1.8");
        outline.setAttribute("stroke-linejoin", "round");
        outline.setAttribute("stroke-linecap", "round");
        icon.appendChild(outline);
        button.appendChild(icon);
      }
      const contextMenu = document.createElement("div");
      contextMenu.className = "context-menu";
      contextMenu.setAttribute("role", "menu");
      contextMenu.setAttribute("aria-label", "视频逐字稿");
      contextMenu.hidden = true;
      const panelMenuItem = document.createElement("button");
      panelMenuItem.type = "button";
      panelMenuItem.className = "context-menu-item";
      panelMenuItem.setAttribute("role", "menuitem");
      panelIcon(panelMenuItem);
      const panelLabel = document.createElement("span");
      panelMenuItem.appendChild(panelLabel);
      panelMenuItem.addEventListener("click", togglePanel);
      panelMenuItem.addEventListener("dblclick", stopPlayerGesture);
      // Stop menu interactions reaching the player's separate pointer handlers.
      contextMenu.addEventListener("pointerdown", (event) => event.stopPropagation());
      contextMenu.addEventListener("mousedown", (event) => event.stopPropagation());
      contextMenu.addEventListener("click", (event) => {
        if (event.composedPath().includes(sourceSelect)) event.stopPropagation();
        else stopPlayerGesture(event);
      });
      contextMenu.addEventListener("dblclick", stopPlayerGesture);
      contextMenu.addEventListener("auxclick", stopPlayerGesture);
      const menuHint = document.createElement("div");
      menuHint.className = "context-menu-hint";
      menuHint.textContent = "Shift + 右键：YouTube 原菜单";
      const sourceControl = document.createElement("label");
      sourceControl.className = "source-control";
      sourceControl.textContent = "原文语言";
      const sourceSelect = document.createElement("select");
      sourceSelect.setAttribute("aria-label", "原文语言");
      for (const [value, label] of [["auto", "自动识别"], ["en", "英语 + 中文"], ["ja", "日语 + 中文"], ["ko", "韩语 + 中文"]]) {
        const option = document.createElement("option");
        option.value = value; option.textContent = label; sourceSelect.appendChild(option);
      }
      sourceSelect.addEventListener("change", changeSourceLanguage);
      const sourceStatus = document.createElement("div");
      sourceStatus.className = "source-status";
      sourceStatus.setAttribute("role", "status");
      sourceControl.append(sourceSelect, sourceStatus);
      contextMenu.append(panelMenuItem, sourceControl, menuHint);
      shadow.appendChild(contextMenu);
      const panelError = document.createElement("div");
      panelError.className = "panel-error";
      panelError.setAttribute("role", "status");
      panelError.hidden = true;
      const panelErrorText = document.createElement("span");
      const panelRetry = document.createElement("button");
      panelRetry.type = "button";
      panelRetry.className = "panel-retry";
      panelRetry.textContent = "重试";
      panelRetry.addEventListener("click", togglePanel);
      panelRetry.addEventListener("dblclick", stopPlayerGesture);
      const panelDismiss = document.createElement("button");
      panelDismiss.type = "button";
      panelDismiss.className = "panel-dismiss";
      panelDismiss.textContent = "×";
      panelDismiss.title = "关闭提示";
      panelDismiss.setAttribute("aria-label", "关闭提示");
      panelDismiss.addEventListener("click", (event) => {
        stopPlayerGesture(event);
        panelController.dismissError();
      });
      for (const name of ["pointerdown", "mousedown"]) panelError.addEventListener(name, (event) => event.stopPropagation());
      for (const name of ["click", "dblclick", "auxclick"]) panelError.addEventListener(name, stopPlayerGesture);
      panelError.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); panelController.dismissError(); }
      });
      panelError.append(panelErrorText, panelRetry, panelDismiss);
      shadow.appendChild(panelError);
      const captions = document.createElement("div");
      captions.className = "captions";
      captions.hidden = true;
      const original = document.createElement("div");
      original.className = "original";
      original.dir = "auto";
      const translation = document.createElement("div");
      translation.className = "translation";
      translation.lang = "zh-CN";
      const status = document.createElement("div");
      status.className = "status";
      status.setAttribute("role", "status");
      const actions = document.createElement("div");
      actions.className = "actions";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "重试";
      retry.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); controller.retry(); });
      const settings = document.createElement("button");
      settings.type = "button";
      settings.textContent = "打开设置";
      settings.addEventListener("click", (event) => {
        event.preventDefault(); event.stopPropagation();
        void request({ action: "openOptions" }).catch(() => { status.textContent = "请从扩展菜单打开设置；更新扩展后请刷新视频页面。"; });
      });
      actions.append(retry, settings);
      captions.append(original, translation, status, actions);
      shadow.appendChild(captions);
      const nativeStyle = document.createElement("style");
      nativeStyle.textContent = `.${ACTIVE_CLASS} .ytp-caption-window-container { visibility:hidden !important; }`;
      player.append(nativeStyle, host);
      view = { host, shadow, toggle, captions, original, translation, status, actions, nativeStyle,
        contextMenu, sourceSelect, sourceStatus, panelMenuItem, panelLabel, panelError, panelErrorText, panelRetry };
      function listen(target, name, handler, options) {
        target.addEventListener(name, handler, options);
        unbind.push(() => target.removeEventListener(name, handler, options));
      }
      listen(document, "contextmenu", showPanelMenu, true);
      listen(document, "pointerdown", dismissPanelMenu, true);
      listen(document, "focusin", dismissPanelMenu, true);
      listen(document, "keydown", panelMenuKeydown, true);
      listen(window, "blur", hidePanelMenu);
      for (const name of ["timeupdate", "seeking", "seeked", "play", "pause", "ended", "loadedmetadata", "durationchange"]) listen(video, name, tick);
      for (const name of ["mousemove", "mouseenter", "touchstart", "focusin"]) listen(player, name, showControls);
      const playerObserver = new window.MutationObserver(() => { tick(); updateLayout(); });
      playerObserver.observe(player, { attributes: true, attributeFilter: ["class"] });
      unbind.push(() => playerObserver.disconnect());
      if (window.ResizeObserver) {
        const resizeObserver = new window.ResizeObserver(updateLayout);
        resizeObserver.observe(player);
        unbind.push(() => resizeObserver.disconnect());
      }
      renderView();
      renderPanelView();
      panelController.refresh();
      tick();
      showControls();
    }

    function reconcile() {
      reconcileTimer = null;
      if (destroyed || navigating) return;
      const id = watchVideoId(window.location.href);
      const nextPlayer = id ? document.querySelector(PLAYER_SELECTOR) : null;
      const nextVideo = nextPlayer?.querySelector("video.html5-main-video, video") || null;
      controller.setVideo(id);
      panelController.setVideo(id);
      if (!nextPlayer || !nextVideo) {
        detach();
        controller.tick(0, true);
        return;
      }
      if (player !== nextPlayer || video !== nextVideo || !view?.host.isConnected) {
        detach();
        attach(nextPlayer, nextVideo);
      }
      tick();
    }

    function scheduleReconcile() {
      if (!destroyed && reconcileTimer === null) reconcileTimer = window.setTimeout(reconcile, 150);
    }

    function navigateStart() {
      navigating = true;
      controller.setVideo("");
      panelController.setVideo("");
      detach();
      window.clearTimeout(navigationTimer);
      navigationTimer = window.setTimeout(navigateFinish, 3500);
    }
    function navigateFinish() { navigating = false; window.clearTimeout(navigationTimer); reconcile(); }
    function preferenceMessage(message) {
      panelController.receive(message);
      if (message?.action === "subtitleSourceChanged" && message.videoId === watchVideoId(window.location.href)) {
        // A panel or another tab can change the language while this menu's
        // lookup is pending. The broadcast is newer than that lookup.
        sourceRevision += 1;
        sourceChangeCount += 1;
        controller.reloadSource();
        if (message.sourceLanguage) renderSourceLanguage(message.sourceLanguage);
      }
      if (message?.action === "subtitlePreferenceChanged" && typeof message.enabled === "boolean") {
        preferenceRevision += 1;
        applyPreference(message.enabled);
      }
    }
    function visibilityChange() {
      if (document.visibilityState === "hidden") hidePanelMenu();
      if (document.visibilityState !== "hidden" && !navigating) panelController.refresh();
    }
    const pageObserver = new window.MutationObserver(scheduleReconcile);
    pageObserver.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener("yt-navigate-start", navigateStart);
    document.addEventListener("yt-navigate-finish", navigateFinish);
    document.addEventListener("fullscreenchange", updateLayout);
    document.addEventListener("visibilitychange", visibilityChange);
    window.addEventListener("popstate", scheduleReconcile);
    window.addEventListener("resize", updateLayout);
    chrome.runtime.onMessage.addListener(preferenceMessage);
    const instance = { destroy() {
      destroyed = true;
      controller.destroy();
      panelController.destroy();
      detach();
      pageObserver.disconnect();
      window.clearTimeout(reconcileTimer);
      window.clearTimeout(navigationTimer);
      document.removeEventListener("yt-navigate-start", navigateStart);
      document.removeEventListener("yt-navigate-finish", navigateFinish);
      document.removeEventListener("fullscreenchange", updateLayout);
      document.removeEventListener("visibilitychange", visibilityChange);
      window.removeEventListener("popstate", scheduleReconcile);
      window.removeEventListener("resize", updateLayout);
      chrome.runtime.onMessage.removeListener(preferenceMessage);
    } };
    window.__YTD_SUBTITLE_OVERLAY__ = instance;
    reconcile();
    void loadPreference();
    return instance;
  }

  const api = { watchVideoId, activeSegmentIndex, contextMenuPosition, createController, createPanelController, displayText, suppressNativeCaptions, requestWithTimeout, install };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else if (root.document && root.chrome?.runtime) install(root, root.document, root.chrome);
})(typeof window === "undefined" ? globalThis : window);
