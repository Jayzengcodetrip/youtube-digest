/** Shared semantic captions for the side panel and player subtitles. */
(function (root, factory) {
  const cleanup = typeof module === "object" && module.exports
    ? require("./transcript-cleanup.js") : root.YTD_TRANSCRIPT_CLEANUP;
  const api = factory(cleanup);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.YTD_TRANSCRIPT_SEGMENTS = api;
})(globalThis, function (YTD_TRANSCRIPT_CLEANUP) {
"use strict";

const TRANSCRIPT_SEGMENT_LIMITS = Object.freeze({
  minChars: 60,
  idealChars: 180,
  maxChars: 320,
  maxSeconds: 20,
});

function normalizeCaptionText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2")
    .replace(/([，。；：！？])\s+(?=[\u3400-\u9fff])/g, "$1")
    .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
    .trim();
}

function isJapaneseCaption(text, language) {
  const code = String(language || "").trim().toLowerCase();
  if (/^(?:ja(?:[-_].*)?|jpn|japanese)$/.test(code)) return true;
  // An explicit language takes precedence; kana is only a fallback for tracks
  // that omit their language. Hangul is deliberately not a no-space script.
  return (!code || /^(?:und|unknown|auto)$/.test(code)) && /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
}

function joinCaptionText(left, right, japanese) {
  const noSpace = japanese &&
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々。、！？」』）]$/u.test(left) &&
    /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々「『（]/u.test(right);
  return normalizeCaptionText(`${left}${noSpace ? "" : " "}${right}`);
}

/**
 * Splits a single oversized thought at the strongest nearby punctuation.
 * Word boundaries are the final safety valve for captions with no punctuation.
 */
function splitOversizedThought(text, maxChars, japanese = false) {
  const parts = [];
  let rest = normalizeCaptionText(text);

  while (rest.length > maxChars) {
    const windowText = rest.slice(0, maxChars + 1);
    const lowerBound = Math.floor(maxChars * 0.55);
    let cut = -1;

    for (const pattern of [/[;:；：]\s*/g, japanese ? /[,，、]\s*/g : /[,，]\s*/g, /\s/g]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(windowText))) {
        if (match.index >= lowerBound) cut = match.index + match[0].length;
      }
      if (cut > 0) break;
    }

    if (cut <= 0) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) parts.push(rest);
  return parts;
}

/**
 * Reconstructs complete sentences across raw caption boundaries. Each segment
 * keeps the timestamp of the first caption that contributed text. Character
 * and time limits prevent a malformed Supadata entry from becoming one giant
 * row while punctuation remains the preferred boundary.
 */
function groupTranscriptEntries(entries, limits = TRANSCRIPT_SEGMENT_LIMITS, withTiming = false) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const pieces = [];
  entries.forEach((entry, entryIndex) => {
    const language = entry?.language || entry?.lang;
    const text = normalizeCaptionText(
      YTD_TRANSCRIPT_CLEANUP.cleanText(entry?.text, language),
    );
    if (!text) return;
    const japanese = isJapaneseCaption(text, language);
    const start = Number.isFinite(Number(entry.start)) ? Number(entry.start) : 0;
    const duration = Math.max(0, Number(entry.duration) || 0);
    const sentenceParts =
      text.match(japanese
        ? /[^.!?;:,。！？；：，、]+(?:[.!?;:,。！？；：，、]+["')\]”’）】」』]*|$)/g
        : /[^.!?;:,。！？；：，]+(?:[.!?;:,。！？；：，]+["')\]”’）】」』]*|$)/g) ||
      [text];
    let consumedChars = 0;

    sentenceParts.forEach((sentencePart) => {
      const cleanPart = normalizeCaptionText(sentencePart);
      if (!cleanPart) return;
      const oversizedParts = splitOversizedThought(cleanPart, limits.maxChars, japanese);
      oversizedParts.forEach((part, partIndex) => {
        const ratio = text.length ? Math.min(1, consumedChars / text.length) : 0;
        pieces.push({
          text: part,
          japanese,
          start: start + duration * ratio,
          end: start + duration * Math.min(1, (consumedChars + part.length) / text.length),
          semanticEnd:
            /[.!?。！？]["')\]”’）】」』]*$/.test(part) ||
            oversizedParts.length > 1,
          clauseEnd: (japanese ? /[;:,；：，、]["')\]”’）】」』]*$/ : /[;:,；：，]["')\]”’）】」』]*$/).test(part),
          sourceOrder: `${entryIndex}:${partIndex}`,
        });
        consumedChars += part.length + 1;
      });
    });
  });

  const grouped = [];
  let current = null;

  const flush = () => {
    if (!current || !current.text.trim()) return;
    const index = grouped.length;
    const text = normalizeCaptionText(current.text);
    grouped.push({
      id: `segment-${index}-${Math.round(current.start * 1000)}`,
      start: current.start,
      text,
      texts: [text],
      ...(withTiming ? { end: current.end } : {}),
    });
    current = null;
  };

  pieces.forEach((piece) => {
    // Do not combine dialogue across a scene break or a long music-only gap:
    // the later sentence would otherwise appear as soon as the first starts.
    if (current && Number.isFinite(current.end) && piece.start - current.end >= 5) flush();
    if (!current) current = { start: piece.start, text: "", japanese: piece.japanese };
    current.text = joinCaptionText(current.text, piece.text, current.japanese || piece.japanese);
    current.japanese = piece.japanese;
    current.end = Math.max(current.end || 0, piece.end);
    const elapsed = Math.max(0, piece.start - current.start);
    const comfortablySized = current.text.length >= limits.minChars;
    const reachedIdeal = current.text.length >= limits.idealChars;
    const atNaturalBoundary =
      piece.semanticEnd ||
      (piece.clauseEnd &&
        (reachedIdeal ||
          current.text.length >= limits.maxChars ||
          elapsed >= limits.maxSeconds));
    const reachedGuardrail =
      atNaturalBoundary &&
      (current.text.length >= limits.maxChars || elapsed >= limits.maxSeconds);
    const reachedHardGuardrail =
      current.text.length >= Math.round(limits.maxChars * 1.2) ||
      elapsed >= limits.maxSeconds + 5;

    if (
      (atNaturalBoundary && (comfortablySized || elapsed >= 8)) ||
      (atNaturalBoundary && reachedIdeal) ||
      reachedGuardrail ||
      reachedHardGuardrail
    ) {
      flush();
    }
  });
  flush();

  return grouped;
}

/** Existing cache identity is intentionally unchanged across the 1.3 upgrade. */
function cacheKey(segment, videoId) {
  return `${videoId}:zh:clean${YTD_TRANSCRIPT_CLEANUP.VERSION}:semantic:${segment.id}:${segment.text}`;
}

/** Add display end times without changing side-panel segmentation or identity. */
function buildPlaybackSegments(entries) {
  const segments = groupTranscriptEntries(entries, TRANSCRIPT_SEGMENT_LIMITS, true);
  return segments.map((segment, index) => {
    const nextStart = segments[index + 1]?.start;
    // A few native tracks omit durations. Keep that caption readable, bounded
    // by the next segment, instead of leaving the final text on screen forever.
    const measuredEnd = segment.end > segment.start ? segment.end : segment.start + 5;
    const end = Number.isFinite(nextStart) ? Math.min(measuredEnd, nextStart) : measuredEnd;
    return { id: segment.id, start: segment.start, end, text: segment.text };
  });
}

return Object.freeze({
  TRANSCRIPT_SEGMENT_LIMITS, normalizeCaptionText, splitOversizedThought,
  groupTranscriptEntries, cacheKey, buildPlaybackSegments,
});
});
