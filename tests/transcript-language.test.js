const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const language = require("../transcript-language.js");
const { normalizeLanguage, chooseLanguage } = language;
const plain = value => JSON.parse(JSON.stringify(value));

test("language codes normalize regions and common aliases but reject undetermined or malformed values", () => {
  for (const [input, expected] of [["EN-us", "en"], ["JA_jp", "ja"], ["ko-KR", "ko"], ["jpn", "ja"], ["kor", "ko"], ["zh-Hans", "zh"], ["und", null], ["mul", null], ["", null], [null, null], ["https://example.com", null], ["ko.4", null]]) {
    assert.equal(normalizeLanguage(input), expected, String(input));
  }
});

test("explicit original audio wins over English captions and unrelated default tracks", () => {
  const decision = chooseLanguage({
    audioTracks: [{ id: "ja.4", name: "Japanese (original)" }, { id: "en.1", audioIsDefault: true }],
    selectedAudioTrack: { id: "en.1", languageCode: "en" },
    captionTracks: [{ languageCode: "en", kind: "asr" }, { languageCode: "ja" }],
  });
  assert.deepEqual(decision, { language: "ja", reason: "original-audio", availableLanguages: ["en", "ja"] });
  assert.equal(chooseLanguage({ originalLanguages: ["ko-KR"], captionTracks: [{ languageCode: "en" }] }).language, "ko");
  assert.equal(chooseLanguage({ audioTracks: [{ languageCode: "ko", isOriginal: true }] }).language, "ko");
});

test("default audio, viewer locale, subtitle defaults and available Korean tracks never imply original Korean", () => {
  const decision = chooseLanguage({
    audioTracks: [{ id: "ko.4", audioIsDefault: true }],
    selectedAudioTrack: { id: "ja.1", languageCode: "ja" },
    defaultCaptionTrackIndex: 3,
    viewerLanguage: "ko",
    captionTracks: ["zh", "en", "ja", "ko", "es"].map(languageCode => ({ languageCode })),
  });
  assert.equal(decision.language, null);
  assert.equal(decision.reason, "ambiguous-caption-language");
});

test("single ASR language is preferred over manual translations, duplicate regional tracks are collapsed", () => {
  assert.deepEqual(chooseLanguage({ captionTracks: [
    { languageCode: "en" }, { languageCode: "ko-KR", kind: "asr" }, { languageCode: "ko", kind: "asr" },
  ] }), { language: "ko", reason: "auto-caption", availableLanguages: ["en", "ko"] });
  assert.equal(chooseLanguage({ captionTracks: [{ languageCode: "en", kind: "asr" }, { languageCode: "ja", kind: "asr" }] }).language, null);
});

test("sole supported caption language is usable, unsupported original evidence never falls through to English", () => {
  assert.equal(chooseLanguage({ captionTracks: [{ languageCode: "ja" }] }).language, "ja");
  assert.equal(chooseLanguage({ captionTracks: [{ languageCode: "en" }] }).language, "en");
  assert.deepEqual(chooseLanguage({ originalLanguages: ["zh"], captionTracks: [{ languageCode: "en" }] }), {
    language: null, reason: "unsupported-original-language", availableLanguages: ["en"],
  });
  assert.equal(chooseLanguage({ captionTracks: [{ languageCode: "fr", kind: "asr" }, { languageCode: "en" }] }).language, null);
});

test("conflicting explicit original evidence and absent metadata stay unknown", () => {
  assert.equal(chooseLanguage({ originalLanguages: ["ja", "ko"] }).reason, "conflicting-original-language");
  assert.deepEqual(chooseLanguage(), { language: null, reason: "unavailable", availableLanguages: [] });
});

const root = path.resolve(__dirname, "..");
const videoId = "1qOJvWakMz0";
const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
function loadResolver({ response, getResponse, selectedAudioTrack, getTab = async () => ({ url: videoUrl }), afterExtract } = {}) {
  const listeners = { addListener() {} };
  let extracted;
  let injections = 0;
  const sandbox = {
    URL, console, setTimeout, clearTimeout, importScripts() {}, YTD_TRANSCRIPT_LANGUAGE: language,
    chrome: {
      storage: { local: { setAccessLevel: async () => {} } },
      action: { onClicked: listeners },
      sidePanel: { setPanelBehavior() {} },
      runtime: { onMessage: listeners, onInstalled: listeners },
      tabs: { onUpdated: listeners, onActivated: listeners, get: getTab },
      scripting: { executeScript: async options => {
        injections++;
        assert.equal(options.target.tabId, 7);
        assert.equal(options.world, "MAIN");
        assert.deepEqual(plain(options.args), [videoId]);
        const location = new URL(videoUrl);
        const player = {
          getPlayerResponse: getResponse || (() => response),
          getAudioTrack: () => selectedAudioTrack,
        };
        extracted = vm.runInNewContext(`(${options.func.toString()})(${JSON.stringify(videoId)})`, {
          URL, location, document: { getElementById: id => id === "movie_player" ? player : null },
        });
        afterExtract?.();
        return [{ result: extracted }];
      } },
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), sandbox);
  return {
    resolve: sandbox.__YTD_TRANSLATION_TESTING__.resolveTranscriptLanguage,
    extracted: () => plain(extracted),
    injections: () => injections,
  };
}

test("MAIN extraction reads exact-video language evidence and returns only sanitized metadata", async () => {
  const fixture = loadResolver({ response: {
    videoDetails: { videoId, defaultAudioLanguage: "ko-KR", title: "Private video title" },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [
      { languageCode: "en", baseUrl: "https://signed.invalid/token" },
      { languageCode: "ko", kind: "asr", vssId: ".ko", name: { simpleText: "Korean" } },
    ] } },
    streamingData: { adaptiveFormats: [{ url: "https://signed.invalid/private", audioTrack: {
      id: "ko.4", audioIsDefault: true, displayName: "Korean (original)", secret: "not exported",
    } }] },
  } });
  assert.deepEqual(plain(await fixture.resolve(videoId, 7)), {
    language: "ko", reason: "original-audio", availableLanguages: ["en", "ko"],
  });
  const extracted = fixture.extracted();
  assert.deepEqual(Object.keys(extracted).sort(), ["audioTracks", "captionTracks", "originalLanguages", "selectedAudioTrack"]);
  assert.doesNotMatch(JSON.stringify(extracted), /signed|private|secret|Private video/);
});

test("actual ambiguous manual-caption shape stays unknown even with English and Korean available", async () => {
  const fixture = loadResolver({ response: {
    videoDetails: { videoId },
    captions: { playerCaptionsTracklistRenderer: {
      defaultCaptionTrackIndex: 1,
      captionTracks: ["zh", "en", "ja", "ko", "es"].map(languageCode => ({ languageCode })),
    } },
  }, selectedAudioTrack: { id: "und", audioIsDefault: true } });
  const result = await fixture.resolve(videoId, 7);
  assert.equal(result.language, null);
  assert.equal(result.reason, "ambiguous-caption-language");
});

test("a different tab or stale player identity prevents language reuse", async () => {
  const changedTab = loadResolver({ getTab: async () => ({ url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" }) });
  assert.equal((await changedTab.resolve(videoId, 7)).reason, "video-changed");
  assert.equal(changedTab.injections(), 0);
  const stalePlayer = loadResolver({ response: { videoDetails: { videoId: "aaaaaaaaaaa", defaultAudioLanguage: "ja" } } });
  assert.equal((await stalePlayer.resolve(videoId, 7)).language, null);
});

test("identity is checked again after metadata extraction and after the injection returns", async () => {
  let playerReads = 0;
  const changingPlayer = loadResolver({ getResponse: () => ({ videoDetails: {
    videoId: ++playerReads === 1 ? videoId : "aaaaaaaaaaa", defaultAudioLanguage: "ja",
  } }) });
  assert.equal((await changingPlayer.resolve(videoId, 7)).language, null);
  let tabChanged = false;
  const changingTab = loadResolver({
    response: { videoDetails: { videoId, defaultAudioLanguage: "ko" } },
    getTab: async () => ({ url: tabChanged ? "https://www.youtube.com/watch?v=aaaaaaaaaaa" : videoUrl }),
    afterExtract: () => { tabChanged = true; },
  });
  assert.equal((await changingTab.resolve(videoId, 7)).reason, "video-changed");
});
