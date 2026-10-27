/** Detect an original caption language only from language-bearing player evidence. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.YTD_TRANSCRIPT_LANGUAGE = api;
})(globalThis, function () {
"use strict";

const SUPPORTED_LANGUAGES = Object.freeze(["en", "ja", "ko"]);
const aliases = Object.freeze({ eng: "en", jpn: "ja", kor: "ko", zho: "zh", chi: "zh" });

function normalizeLanguage(value) {
  if (typeof value !== "string") return null;
  const code = value.trim().replaceAll("_", "-").toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(code)) return null;
  const base = code.split("-")[0];
  return ["und", "mul", "zxx"].includes(base) ? null : aliases[base] || base;
}

function uniqueLanguages(values) {
  return [...new Set(values.map(normalizeLanguage).filter(Boolean))];
}

function audioLanguage(track) {
  return normalizeLanguage(track?.languageCode) ||
    normalizeLanguage(typeof track?.id === "string" ? track.id.split(".")[0] : null);
}

function originalAudio(track) {
  if (!track || typeof track !== "object") return false;
  if (track.isOriginal === true) return true;
  // A default track can be a viewer-selected dub. Only an explicit original
  // marker establishes the source language; never use audioIsDefault alone.
  return /(?:\boriginal\b|オリジナル|原音|原声|원본|오리지널)/iu.test(track.name || "");
}

function chooseLanguage(metadata = {}) {
  const captionTracks = Array.isArray(metadata.captionTracks) ? metadata.captionTracks : [];
  const availableLanguages = uniqueLanguages(captionTracks.map(track => track?.languageCode));
  const result = (language, reason) => ({ language, reason, availableLanguages });
  const originalLanguages = uniqueLanguages([
    ...(Array.isArray(metadata.originalLanguages) ? metadata.originalLanguages : []),
    ...(Array.isArray(metadata.audioTracks) ? metadata.audioTracks : [])
      .filter(originalAudio).map(audioLanguage),
    ...(originalAudio(metadata.selectedAudioTrack) ? [audioLanguage(metadata.selectedAudioTrack)] : []),
  ]);
  if (originalLanguages.length > 1) return result(null, "conflicting-original-language");
  if (originalLanguages.length === 1) {
    const language = originalLanguages[0];
    return result(SUPPORTED_LANGUAGES.includes(language) ? language : null,
      SUPPORTED_LANGUAGES.includes(language) ? "original-audio" : "unsupported-original-language");
  }

  const autoLanguages = uniqueLanguages(captionTracks
    .filter(track => track?.kind === "asr").map(track => track.languageCode));
  if (autoLanguages.length === 1) {
    const language = autoLanguages[0];
    return result(SUPPORTED_LANGUAGES.includes(language) ? language : null,
      SUPPORTED_LANGUAGES.includes(language) ? "auto-caption" : "unsupported-auto-caption-language");
  }
  if (autoLanguages.length > 1) return result(null, "ambiguous-auto-caption-language");
  if (availableLanguages.length === 1 && SUPPORTED_LANGUAGES.includes(availableLanguages[0])) {
    return result(availableLanguages[0], "single-caption");
  }
  return result(null, availableLanguages.length ? "ambiguous-caption-language" : "unavailable");
}

return Object.freeze({ normalizeLanguage, chooseLanguage, SUPPORTED_LANGUAGES });
});
