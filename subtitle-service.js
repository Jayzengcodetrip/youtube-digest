/** Shared, credential-free coordination for panel and player subtitles. */
(function (root) {
  "use strict";

  const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
  const PREFERENCE_KEY = "ytd_subtitles_enabled";
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const INTERRUPTED = "字幕请求已中断，请点击重试。";
  const plainObject = (value) => value && typeof value === "object" && !Array.isArray(value);

  function create({ storage, fetchTranscript, translate, segments, cleanup, resolveLanguage, now = Date.now }) {
    const transcriptTasks = new Map();
    const translationTasks = new Map();
    const sourceEpochs = new Map();
    const detectedSources = new Map();
    const detectionTasks = new Map();
    const SOURCE_LANGUAGES = new Set(["en", "ja", "ko"]);
    const SOURCE_PREFERENCES = new Set(["auto", ...SOURCE_LANGUAGES]);
    const sourcePreferenceKey = (videoId) => `ytd_source_language_${videoId}`;
    const sourceEpoch = (videoId) => sourceEpochs.get(videoId) || 0;
    const normalizeLanguage = (language) => {
      const code = typeof language === "string" ? language.toLowerCase().split(/[-_]/)[0] : "";
      return /^[a-z]{2,3}$/.test(code) ? code : null;
    };
    function staleTrackError() {
      const error = new Error("字幕语言已切换，请重新加载当前字幕。");
      error.code = "SUBTITLE_TRACK_CHANGED";
      return error;
    }
    function trackIdentity(videoId, language, transcript) {
      // IDs can coincide across languages. Text and timing give the entire
      // selected track a stable identity without changing legacy paragraph keys.
      const value = JSON.stringify(transcript.map(({ start, duration, text }) => [start, duration, text]));
      let hash = 2166136261;
      for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
      return `${videoId}:${language}:${(hash >>> 0).toString(16)}`;
    }
    function cleanTrack(value, videoId, fallbackLanguage = "en") {
      if (!plainObject(value)) return null;
      const language = normalizeLanguage(value.language || value.transcriptLanguage) ||
        normalizeLanguage(value.transcript?.find((entry) => entry.language)?.language) || fallbackLanguage;
      const transcript = cleanup.cleanupEntries((Array.isArray(value.transcript) ? value.transcript : [])
        .map((entry) => ({ ...entry, language })));
      if (!transcript.length) return null;
      return {
        transcript, language,
        trackKey: trackIdentity(videoId, language, transcript),
        availableLanguages: [...new Set((Array.isArray(value.availableLanguages) ? value.availableLanguages : []).map(normalizeLanguage).filter(Boolean))],
      };
    }
    function applyTrack(record, track) {
      return {
        ...record,
        transcript: track.transcript,
        transcriptLanguage: track.language,
        transcriptTrackKey: track.trackKey,
        transcriptText: track.transcript.map((entry) => entry.text).join(" "),
        transcriptTimestamped: track.transcript.map((entry) => {
          const seconds = Math.max(0, Math.floor(entry.start));
          return `[${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}] ${entry.text}`;
        }).join("\n"),
        transcriptCleanupVersion: cleanup.VERSION,
      };
    }
    // Every digest read/modify/write passes this queue, including panel saves.
    // A single queue also prevents cache eviction racing writes for other videos.
    let writeTail = Promise.resolve();
    function write(operation) {
      const task = writeTail.catch(() => {}).then(operation);
      writeTail = task.catch(() => {});
      return task;
    }
    function validateVideoId(videoId) {
      if (typeof videoId !== "string" || !VIDEO_ID.test(videoId)) {
        throw new Error("Invalid YouTube video ID");
      }
      return videoId;
    }
    const digestKey = (videoId) => `digest_${videoId}`;
    const jobKey = (videoId, language = "en") => `subtitleJobs_${videoId}${language === "en" ? "" : `_${language}`}`;
    const prefix = (videoId) => `${videoId}:zh:clean${cleanup.VERSION}:semantic:`;
    function cleanTranslations(values, videoId) {
      const cleaned = {};
      if (!plainObject(values)) return cleaned;
      for (const [key, value] of Object.entries(values)) {
        if (!key.startsWith(prefix(videoId)) || typeof value !== "string") continue;
        const text = cleanup.cleanText(value, "zh");
        if (text) cleaned[key] = text;
      }
      return cleaned;
    }
    function cleanRecord(record, videoId) {
      if (!plainObject(record) || !Number.isFinite(record.timestamp) || now() - record.timestamp > MAX_AGE) return null;
      const tracks = {};
      if (plainObject(record.transcriptTracks)) {
        for (const [key, value] of Object.entries(record.transcriptTracks)) {
          const language = normalizeLanguage(key);
          const cleaned = language && cleanTrack(value, videoId, language);
          if (cleaned) tracks[language] = cleaned;
        }
      }
      const current = cleanTrack(record, videoId);
      // Migrate existing English caches in place, including the pre-language
      // records. Completed translations, notes and analysis are never reset.
      if (current && !tracks[current.language]) tracks[current.language] = current;
      const cleaned = {
        ...record,
        transcript: [],
        transcriptTracks: tracks,
        transcriptTrackRequests: plainObject(record.transcriptTrackRequests) ? record.transcriptTrackRequests : {},
        paragraphCache: cleanTranslations(record.paragraphCache, videoId),
      };
      return current ? applyTrack(cleaned, current) : cleaned;
    }
    async function readRecord(videoId) {
      // Storage errors deliberately propagate: treating them as cache misses
      // could consume tokens for translations that already exist.
      const stored = await storage.get(digestKey(videoId));
      return cleanRecord(stored[digestKey(videoId)], videoId);
    }
    async function evict() {
      const all = await storage.get(null);
      const records = Object.keys(all).filter((key) => key.startsWith("digest_"));
      const fresh = records.filter((key) => Number.isFinite(all[key]?.timestamp) && now() - all[key].timestamp <= MAX_AGE)
        .sort((a, b) => all[b].timestamp - all[a].timestamp);
      const keep = new Set(fresh.slice(0, 20));
      const remove = records.filter((key) => !keep.has(key));
      for (const key of Object.keys(all)) {
        if (key.startsWith("subtitleJobs_") && now() - (all[key]?.timestamp || 0) > MAX_AGE) remove.push(key);
      }
      if (remove.length) await storage.remove(remove);
    }
    async function merge(videoId, patch, { preserveTimestamp = false, internal = false } = {}) {
      validateVideoId(videoId);
      if (!plainObject(patch)) throw new Error("Invalid digest cache update");
      return write(async () => {
        const previous = await readRecord(videoId) || {};
        const next = { ...previous };
        const fields = ["analysis", "transcript", "transcriptText", "transcriptTimestamped", "transcriptLanguage", "transcriptCleanupVersion", "videoTitle", "channelName"];
        for (const field of fields) {
          if (!Object.prototype.hasOwnProperty.call(patch, field) || patch[field] === undefined) continue;
          // Only the service selects active tracks. A late save from an old
          // panel may merge useful translations but cannot replace the source.
          if (!internal && previous.transcriptTrackKey && field.startsWith("transcript")) continue;
          // A panel that has not loaded analysis/title yet must not erase it.
          if (["analysis", "videoTitle", "channelName"].includes(field) && !patch[field] && previous[field]) continue;
          next[field] = patch[field];
        }
        next.paragraphCache = cleanTranslations({ ...previous.paragraphCache, ...(plainObject(patch.paragraphCache) ? patch.paragraphCache : {}) }, videoId);
        next.interfaceCache = { ...previous.interfaceCache, ...(plainObject(patch.interfaceCache) ? patch.interfaceCache : {}) };
        if (internal) {
          for (const field of ["subtitlePending", "subtitleFailures"]) {
            if (patch[field]) {
              const values = { ...previous[field], ...patch[field] };
              for (const key of Object.keys(values)) if (values[key] === null) delete values[key];
              next[field] = values;
            }
          }
        }
        next.timestamp = preserveTimestamp && previous.timestamp ? previous.timestamp : now();
        const cleaned = cleanRecord(next, videoId);
        await storage.set({ [digestKey(videoId)]: cleaned });
        await evict();
        return cleaned;
      });
    }
    async function getPreference() {
      const stored = await storage.get(PREFERENCE_KEY);
      return { enabled: stored[PREFERENCE_KEY] === true };
    }
    async function setPreference(enabled) {
      if (typeof enabled !== "boolean") throw new Error("Subtitle preference must be a boolean");
      await storage.set({ [PREFERENCE_KEY]: enabled });
      return { enabled };
    }
    async function readSourcePreference(videoId) {
      const values = await storage.get(sourcePreferenceKey(videoId));
      const preference = values[sourcePreferenceKey(videoId)];
      return SOURCE_PREFERENCES.has(preference) ? preference : "auto";
    }
    async function detectSource(videoId, tabId) {
      if (typeof resolveLanguage !== "function") return { language: null, reason: "unavailable", availableLanguages: [] };
      const key = `${videoId}:${Number.isInteger(tabId) ? tabId : "none"}`;
      const cached = detectedSources.get(key);
      if (cached && now() - cached.timestamp < 30000) return cached.value;
      if (detectionTasks.has(key)) return detectionTasks.get(key);
      const task = (async () => {
        let result;
        try { result = await resolveLanguage(videoId, tabId); } catch (_) { result = null; }
        const language = normalizeLanguage(result?.language);
        const value = {
          language: SOURCE_LANGUAGES.has(language) ? language : null,
          reason: typeof result?.reason === "string" ? result.reason : "unavailable",
          availableLanguages: [...new Set((Array.isArray(result?.availableLanguages) ? result.availableLanguages : [])
            .map(normalizeLanguage).filter(Boolean))],
        };
        detectedSources.set(key, { timestamp: now(), value });
        return value;
      })();
      detectionTasks.set(key, task);
      try { return await task; } finally { if (detectionTasks.get(key) === task) detectionTasks.delete(key); }
    }
    async function getSourceLanguage(videoId, { tabId } = {}) {
      validateVideoId(videoId);
      const preference = await readSourcePreference(videoId);
      const detected = await detectSource(videoId, tabId);
      return {
        preference,
        language: preference === "auto" ? detected.language || "en" : preference,
        reason: preference === "auto" ? (detected.language ? detected.reason : "fallback") : "manual",
        availableLanguages: detected.availableLanguages,
      };
    }
    async function setSourceLanguage(videoId, preference, { tabId } = {}) {
      validateVideoId(videoId);
      if (!SOURCE_PREFERENCES.has(preference)) throw new Error("Choose auto, en, ja or ko for subtitle source language");
      sourceEpochs.set(videoId, sourceEpoch(videoId) + 1);
      await write(() => storage.set({ [sourcePreferenceKey(videoId)]: preference }));
      return getSourceLanguage(videoId, { tabId });
    }
    function transcriptResponse(track, sourceLanguage) {
      const formatted = applyTrack({}, track);
      return {
        success: true,
        transcript: track.transcript,
        transcriptText: formatted.transcriptText,
        transcriptTextTimestamped: formatted.transcriptTimestamped,
        language: track.language,
        trackKey: track.trackKey,
        sourceLanguage: {
          ...sourceLanguage,
          language: track.language,
          availableLanguages: [...new Set([...sourceLanguage.availableLanguages, ...track.availableLanguages])],
        },
      };
    }
    async function fetchSourceTrack(videoId, language, retry) {
      const taskKey = `${videoId}:${language}`;
      if (transcriptTasks.has(taskKey)) return transcriptTasks.get(taskKey);
      const task = (async () => {
        const cached = await readRecord(videoId);
        const cachedTrack = cached?.transcriptTracks?.[cached.transcriptTrackRequests?.[language] || language];
        if (cachedTrack) return cachedTrack;
        const key = jobKey(videoId, language);
        const storedJobs = await storage.get(key);
        const previous = storedJobs[key];
        if (!retry && previous && now() - previous.timestamp <= MAX_AGE) {
          const error = new Error(previous.error || INTERRUPTED);
          error.code = previous.code || "SUBTITLE_REQUEST_INTERRUPTED";
          throw error;
        }
        await write(() => storage.set({ [key]: { pending: true, timestamp: now() } }));
        try {
          const response = await fetchTranscript(videoId, { language });
          if (!response?.success || !Array.isArray(response.transcript) || !response.transcript.length) {
            const error = new Error(response?.message || response?.error || "No spoken subtitle track is available");
            error.code = response?.error || "NO_TRANSCRIPT";
            throw error;
          }
          const track = cleanTrack(response, videoId, language);
          if (!track) throw new Error("No spoken subtitle track is available");
          // An explicit Japanese/Korean request must never silently use the
          // provider's English fallback. English keeps its legacy fallback.
          if (language !== "en" && track.language !== language) {
            const error = new Error(`该视频没有可用的${language === "ja" ? "日语" : "韩语"}字幕，请选择其他字幕语言。`);
            error.code = "SOURCE_LANGUAGE_UNAVAILABLE";
            throw error;
          }
          await write(async () => {
            const previous = await readRecord(videoId) || {};
            const next = cleanRecord({
              ...previous,
              transcriptTracks: { ...previous.transcriptTracks, [track.language]: track },
              transcriptTrackRequests: { ...previous.transcriptTrackRequests, [language]: track.language },
              timestamp: now(),
            }, videoId);
            await storage.set({ [digestKey(videoId)]: next });
            await storage.remove(key);
            await evict();
          });
          return track;
        } catch (error) {
          await write(() => storage.set({ [key]: { error: error.message, code: error.code, timestamp: now() } }));
          throw error;
        }
      })();
      transcriptTasks.set(taskKey, task);
      task.then(() => { if (transcriptTasks.get(taskKey) === task) transcriptTasks.delete(taskKey); },
        () => { if (transcriptTasks.get(taskKey) === task) transcriptTasks.delete(taskKey); });
      return task;
    }
    async function getTranscript(videoId, { retry = false, tabId } = {}) {
      validateVideoId(videoId);
      const epoch = sourceEpoch(videoId);
      const sourceLanguage = await getSourceLanguage(videoId, { tabId });
      if (epoch !== sourceEpoch(videoId)) throw staleTrackError();
      const track = await fetchSourceTrack(videoId, sourceLanguage.language, retry);
      await write(async () => {
        if (epoch !== sourceEpoch(videoId) || await readSourcePreference(videoId) !== sourceLanguage.preference) throw staleTrackError();
        const previous = await readRecord(videoId) || {};
        // Source selection invalidates work immediately, including while an
        // earlier operation is awaiting storage inside this serialized queue.
        if (epoch !== sourceEpoch(videoId)) throw staleTrackError();
        await storage.set({ [digestKey(videoId)]: applyTrack({ ...previous,
          transcriptSourcePreference: sourceLanguage.preference, timestamp: previous.timestamp || now() }, track) });
      });
      if (epoch !== sourceEpoch(videoId)) throw staleTrackError();
      return transcriptResponse(track, sourceLanguage);
    }
    async function getTrack(videoId, options) {
      const epoch = sourceEpoch(videoId);
      const response = await getTranscript(videoId, options);
      const track = segments.buildPlaybackSegments(response.transcript);
      const record = await readRecord(videoId);
      if (epoch !== sourceEpoch(videoId)) throw staleTrackError();
      const translations = {};
      for (const segment of track) {
        const text = record?.paragraphCache?.[segments.cacheKey(segment, videoId)];
        if (text) translations[segment.id] = text;
      }
      return { videoId, segments: track.map(({ id, start, end, text }) => ({ id, start, end, text })), translations,
        trackKey: response.trackKey, sourceLanguage: response.sourceLanguage };
    }
    async function translateSegments(videoId, segmentIds, { retry = false, tabId, trackKey } = {}) {
      validateVideoId(videoId);
      if (!Array.isArray(segmentIds) || !segmentIds.length || segmentIds.length > 4 || segmentIds.some((id) => typeof id !== "string") || new Set(segmentIds).size !== segmentIds.length) {
        throw new Error("Request between 1 and 4 unique subtitle segment IDs");
      }
      const epoch = sourceEpoch(videoId);
      let transcript;
      if (trackKey !== undefined) {
        // Translation follows the track already displayed. Do not redetect the
        // original language per paragraph: late native metadata must not switch
        // an otherwise healthy playback session to another track mid-sentence.
        const preference = await readSourcePreference(videoId);
        const record = await readRecord(videoId);
        if (!record || record.transcriptTrackKey !== trackKey ||
          (record.transcriptSourcePreference || "auto") !== preference) throw staleTrackError();
        transcript = { transcript: record.transcript, trackKey };
      } else {
        transcript = await getTranscript(videoId, { retry, tabId });
      }
      const canonical = new Map(segments.buildPlaybackSegments(transcript.transcript).map((segment) => [segment.id, segment]));
      if (segmentIds.some((id) => !canonical.has(id))) throw new Error("Unknown subtitle segment ID");
      // Claim against the latest cache under the same lock used by completion.
      // Otherwise a stale read racing a just-finished task could bill twice.
      const { claimed, promises, videoTitle } = await write(async () => {
      if (epoch !== sourceEpoch(videoId)) throw staleTrackError();
      const record = await readRecord(videoId);
      if (epoch !== sourceEpoch(videoId)) throw staleTrackError();
      if (record?.transcriptTrackKey !== transcript.trackKey) throw staleTrackError();
      const claimed = [];
      const promises = segmentIds.map((id) => {
        const segment = canonical.get(id);
        const key = segments.cacheKey(segment, videoId);
        const text = record?.paragraphCache?.[key];
        if (text) return Promise.resolve({ id, text });
        if (translationTasks.has(key)) return translationTasks.get(key).promise;
        const previousError = record?.subtitleFailures?.[key] || (record?.subtitlePending?.[key] ? INTERRUPTED : "");
        if (previousError && !retry) return Promise.resolve({ id, text: "", error: previousError });
        let resolve;
        const promise = new Promise((done) => { resolve = done; });
        const task = { key, segment, promise, resolve };
        translationTasks.set(key, task);
        claimed.push(task);
        return promise;
      });
      return { claimed, promises, videoTitle: record?.videoTitle || "" };
      });
      if (claimed.length) void runBatch(videoId, claimed, videoTitle);
      return { videoId, segments: await Promise.all(promises), trackKey: transcript.trackKey };
    }
    async function runBatch(videoId, tasks, videoTitle) {
      let results;
      try {
        await merge(videoId, {
          subtitlePending: Object.fromEntries(tasks.map(({ key }) => [key, now()])),
          subtitleFailures: Object.fromEntries(tasks.map(({ key }) => [key, null])),
        }, { internal: true });
        const response = await translate(tasks.map(({ segment }) => ({ id: segment.id, text: segment.text })), videoTitle);
        if (!response?.success) throw new Error(response?.error || "Translation failed. Please Retry.");
        const rows = new Map((response.translatedContent?.segments || []).map((row) => [row.id, row]));
        results = tasks.map(({ segment }) => {
          const row = rows.get(segment.id);
          const text = typeof row?.text === "string" ? cleanup.cleanText(row.text, "zh") : "";
          return text ? { id: segment.id, text } : { id: segment.id, text: "", error: row?.error || "Missing or invalid Chinese translation. Please Retry." };
        });
        await finishBatch(videoId, tasks, results);
      } catch (error) {
        results = tasks.map(({ segment }) => ({ id: segment.id, text: "", error: error.message || "Translation failed. Please Retry." }));
        // Persist failures so navigation/reopening cannot silently charge again.
        // If storage is unavailable, the pending marker still blocks replay.
        try { await finishBatch(videoId, tasks, results); } catch (_) { /* return visible failure */ }
      } finally {
        tasks.forEach((task, index) => {
          if (translationTasks.get(task.key) === task) translationTasks.delete(task.key);
          task.resolve(results[index]);
        });
      }
    }
    async function finishBatch(videoId, tasks, results) {
      const paragraphCache = {};
      const subtitleFailures = {};
      const subtitlePending = {};
      tasks.forEach(({ key }, index) => {
        const row = results[index];
        if (row.text) paragraphCache[key] = row.text;
        subtitleFailures[key] = row.error || null;
        subtitlePending[key] = null;
      });
      await merge(videoId, { paragraphCache, subtitleFailures, subtitlePending }, { internal: true });
    }
    return { getPreference, setPreference, getSourceLanguage, setSourceLanguage, getTranscript, getTrack, translateSegments, saveDigestCache: merge, prune: () => write(evict) };
  }

  const api = { create, PREFERENCE_KEY };
  root.YTD_SUBTITLE_SERVICE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
