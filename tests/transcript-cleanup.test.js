const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { VERSION, cleanText, cleanupEntries } = require("../transcript-cleanup.js");

const examples = [
  ["What did you [music] do to this? I mean, I've had this for 5 years.",
    "What did you do to this? I mean, I've had this for 5 years."],
  ["[music] I dropped it one time off of a table like below my hip height.",
    "I dropped it one time off of a table like below my hip height."],
  ["It landed on the corner and it just got [music] completely bent.",
    "It landed on the corner and it just got completely bent."],
  ["All the other damage is like Oh. OH [screaming] YEAH. ONE OF THE screws is missing.",
    "All the other damage is like Oh. OH YEAH. ONE OF THE screws is missing."],
  ["[laughter] Uh, the screen is peeling here. It's kind of like there's a crack.",
    "the screen is peeling here. It's kind of like there's a crack."],
  ["它摔到了角上，直接[音乐]完全弯了。", "它摔到了角上，直接完全弯了。"],
  ["[笑声] 呃，屏幕这里在翘边。", "屏幕这里在翘边。"],
];

test("cleans the actual screenshot examples without paraphrasing spoken content", () => {
  for (const [source, expected] of examples) assert.equal(cleanText(source), expected);
});

test("recognizes bounded sound labels in caption bracket variants", () => {
  for (const label of ["[Music]", "(laughter)", "【尖叫声】", "（背景音乐）", "［APPLAUSE］",
    "[soft music playing]", "[music fades out]", "[audience laughter]", "[music and applause]"]) {
    assert.equal(cleanText(`Before ${label} after.`), "Before after.", label);
  }
  assert.equal(cleanText("you[music]do"), "you do");
  assert.equal(cleanText("你好 [音乐] 世界"), "你好世界");
  assert.equal(cleanText("♪ Here are the song lyrics ♫"), "Here are the song lyrics");
});

test("drops sound-only or hesitation-only text including leftover punctuation", () => {
  for (const source of ["[music]", "[laughter] [music]", "♪ ♫ ♬", "[music].", "Uh, um...",
    "呃，", "【笑声】（背景音乐）", "[music] —", ""]) assert.equal(cleanText(source), "", source);
});

test("removes isolated hesitation tokens and their commas", () => {
  assert.equal(cleanText("Um, I, uh, think, erm, it works."), "I think it works.");
  assert.equal(cleanText("Er, what is this?"), "what is this?");
  assert.equal(cleanText("呃，先看这个。"), "先看这个。");
  assert.equal(cleanText("I uh think so."), "I think so.");
  assert.equal(cleanText("Uh. Let's see."), "Let's see.");
  assert.equal(cleanText("Yes, uh, no."), "Yes, no.");
  assert.equal(cleanText("No, um, don't delete it.", "en"), "No, don't delete it.");
});

test("sound-only captions with subtitle formatting do not become empty visible rows", () => {
  assert.equal(cleanText("<i>[music]</i>"), "");
  assert.equal(cleanText("<b><i>[laughter]</i></b>"), "");
  assert.equal(cleanText("<i>Hello [music] world.</i>"), "<i>Hello world.</i>");
});

test("uses track language to avoid deleting foreign words that resemble English fillers", () => {
  for (const [source, language] of [
    ["Er ist hier.", "de"],
    ["Es geht um Sicherheit.", "de-DE"],
    ["Han er lærer.", "nb"],
    ["É um livro.", "pt-BR"],
    ["Um, er und sie kümmern wir uns.", "de"],
  ]) {
    assert.equal(cleanText(source, language), source);
  }
  for (const source of ["Er ist hier.", "Es geht um Sicherheit.", "Han er lærer.", "É um livro.",
    "I um think so.", "Das ist er."]) assert.equal(cleanText(source), source);
  assert.equal(cleanText("I um think so.", "en"), "I think so.");
  assert.equal(cleanText("I er think so.", "en-US"), "I think so.");
  assert.equal(cleanText("[music] Er ist hier.", "de"), "Er ist hier.");
  assert.equal(cleanText("[音乐] 呃，屏幕在这里。", "zh-CN"), "屏幕在这里。");
});

test("unknown language removes ambiguous English fillers only with hesitation punctuation", () => {
  assert.equal(cleanText("[music] Um, let me see."), "let me see.");
  assert.equal(cleanText("Er, let me see."), "let me see.");
  assert.equal(cleanText("I, um, think so."), "I think so.");
  assert.equal(cleanText("I, er, think so."), "I think so.");
  assert.equal(cleanText("Um... let me see."), "let me see.");
  assert.equal(cleanText("I um think so.", "unknown"), "I um think so.");
});

test("entry cleanup honors both language metadata names", () => {
  assert.deepEqual(cleanupEntries([
    { start: 0, text: "I um think so.", language: "en" },
    { start: 1, text: "Er ist hier.", lang: "de" },
    { start: 2, text: "Es geht um Sicherheit.", language: "de", lang: "en" },
  ]), [
    { start: 0, text: "I think so.", language: "en" },
    { start: 1, text: "Er ist hier.", lang: "de" },
    { start: 2, text: "Es geht um Sicherheit.", language: "de", lang: "en" },
  ]);
});

test("preserves meaningful words, units, ordinary brackets, quotations, and code", () => {
  const cases = [
    "I like music, laughter, and screaming in films.",
    "Oh, yeah. Well, I mean, this is like the original.",
    "啊，这个不错。嗯，我同意。", "打嗝时会发出呃呃声。",
    "album [Music for Airports]", "Read (music theory) before class.",
    "The range is [0, 1]. The interval is (a, b).", "[inaudible] is missing speech.",
    "[laughing gas]", "[music and mathematics]", "[formula: um + x]",
    "The word 'um' is a hesitation.", 'The caption literally says "[music]".',
    "He said “Um, I agree.”", "Use `array[um]` and `x  + y`.",
    "UH is a university; ER is a show. A 10 um particle is small.",
    "uh-huh, uh-oh, and uranium are words.", "Well-known (unit: um) notation.",
  ];
  for (const source of cases) assert.equal(cleanText(source), source);
});

test("preserves timings and other metadata without mutating the input", () => {
  const source = [
    { start: 0, duration: 4.2, text: "What did you [music] do?", source: "YouTube" },
    { start: 4.2, duration: 2.8, text: "[music]" },
    { start: 7, duration: 5, text: "[laughter] Uh, the screen is peeling.", speaker: "A" },
  ];
  const snapshot = structuredClone(source);
  assert.deepEqual(cleanupEntries(source), [
    { start: 0, duration: 4.2, text: "What did you do?", source: "YouTube" },
    { start: 7, duration: 5, text: "the screen is peeling.", speaker: "A" },
  ]);
  assert.deepEqual(source, snapshot);
  assert.notEqual(cleanupEntries(source)[0], source[0]);
});

test("cleanup is idempotent and tolerates missing input", () => {
  for (const [source] of examples) assert.equal(cleanText(cleanText(source)), cleanText(source));
  assert.equal(cleanText(null), "");
  assert.equal(cleanText(undefined), "");
  assert.deepEqual(cleanupEntries(undefined), []);
  assert.deepEqual(cleanupEntries([null, {}, { text: "[music]" }]), []);
  assert.equal(VERSION, 1);
});

test("exposes the same browser helper without requiring Node or DOM APIs", () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../transcript-cleanup.js"), "utf8"), context);
  assert.equal(context.YTD_TRANSCRIPT_CLEANUP.cleanText("Hello [music] world."), "Hello world.");
  assert.equal(context.YTD_TRANSCRIPT_CLEANUP.VERSION, VERSION);
});

test("removes exact Japanese and Korean sound markers without changing meaningful speech", () => {
  for (const marker of ['[音楽]', '【拍手】', '（笑い）', '[笑い声]', '[歓声]',
    '[음악]', '(박수)', '[웃음]', '[배경 음악]', '[환호성]', '[音楽、拍手]', '[음악, 박수]']) {
    assert.equal(cleanText(marker), '', marker);
  }
  assert.equal(cleanText('これは[音楽]新しいパソコンです。', 'ja'), 'これは新しいパソコンです。');
  assert.equal(cleanText('これは [笑い] とても静かです。', 'ja-JP'), 'これはとても静かです。');
  assert.equal(cleanText('[拍手] ありがとう。'), 'ありがとう。');
  assert.equal(cleanText('오늘은[음악]새 노트북을 소개합니다.', 'ko'), '오늘은 새 노트북을 소개합니다.');
  assert.equal(cleanText('[웃음] 정말 좋아요.', 'ko-KR'), '정말 좋아요.');
  assert.equal(VERSION, 1, 'English translation cache version stays unchanged');
});

test("keeps Japanese and Korean ordinary words, data labels, quoted speech and mixed bracket content", () => {
  const examples = [
    ['音楽について話します。', 'ja'], ['音楽 [音楽理論] を勉強します。', 'ja'],
    ['[音楽と数学]', 'ja'], ['[笑いの理由]', 'ja'], ['「ええ、そうですね。」', 'ja'],
    ['「[音楽]」と表示します。', 'ja'], ['『[拍手]』という表示です。', 'ja'],
    ['[音楽、データ]', 'ja'], ['値は [0, 1] です。', 'ja'], ['"[音楽]" と表示します。', 'ja'],
    ['음악을 듣고 있어요.', 'ko'], ['[음악 이론] 수업입니다.', 'ko'], ['[웃음의 이유]', 'ko'],
    ['[음악, 데이터]', 'ko'], ['범위는 [0, 1] 입니다.', 'ko'], ['"[웃음]" 이라고 적었어요.', 'ko'],
    ['네, 아니요. 음, 정말 그럴까요?', 'ko'], ['ええ、いいえ。あの人です。', 'ja'],
  ];
  for (const [source, language] of examples) assert.equal(cleanText(source, language), source);
});

test("Japanese and Korean cleanup is idempotent and preserves caption timing and language", () => {
  const entries = [
    {start:0,duration:2,language:'ja',text:'これは[音楽]新しいものです。'},
    {start:2,duration:1,language:'ko',text:'[박수]'},
    {start:3,duration:2,language:'ko',text:'오늘은[웃음]정말 좋아요.'},
  ];
  const before = structuredClone(entries);
  const cleaned = cleanupEntries(entries);
  assert.deepEqual(cleaned, [
    {...entries[0],text:'これは新しいものです。'},
    {...entries[2],text:'오늘은 정말 좋아요.'},
  ]);
  assert.deepEqual(cleanupEntries(cleaned), cleaned);
  assert.deepEqual(entries, before);
});
