const test = require('node:test');
const assert = require('node:assert/strict');
const { groupTranscriptEntries, buildPlaybackSegments, cacheKey, splitOversizedThought } = require('../transcript-segments.js');
const fixtures = require('./fixtures/segments-v1.2.2.json');

for (const fixture of fixtures) {
  test(`1.2.2 translation identities survive shared grouping: ${fixture.name}`, () => {
    const before = structuredClone(fixture.entries);
    assert.deepEqual(groupTranscriptEntries(fixture.entries), fixture.expected);
    assert.deepEqual(fixture.entries, before);
    const playback = buildPlaybackSegments(fixture.entries);
    assert.deepEqual(playback.map(({id, start, text}) => ({id, start, text})),
      fixture.expected.map(({id, start, text}) => ({id, start, text})));
    playback.forEach((segment, i) => {
      assert.equal(cacheKey(segment, 'abcdefghijk'), cacheKey(fixture.expected[i], 'abcdefghijk'));
      assert.ok(Number.isFinite(segment.end));
      assert.ok(segment.end >= segment.start);
      if (playback[i + 1]) assert.ok(segment.end <= playback[i + 1].start);
    });
  });
}

test('end timing leaves an actual silent tail empty and does not display removed sound cues', () => {
  const segments = buildPlaybackSegments([
    {start:0,duration:3,text:'This is a complete spoken sentence long enough to form its own paragraph.'},
    {start:3,duration:7,text:'[music]'},
    {start:10,duration:2,text:'Here is the next complete thought for everyone who is watching this video.'},
  ]);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].end, 3);
  assert.equal(segments[1].start, 10);
  assert.equal(segments[1].end, 12);
});

test('missing duration is bounded, empty inputs remain empty, and unknown HTML stays literal', () => {
  assert.deepEqual(buildPlaybackSegments(null), []);
  assert.deepEqual(buildPlaybackSegments([{start:0,duration:10,text:'[laughter]'}]), []);
  const [segment] = buildPlaybackSegments([{start:6,text:'<img src=x onerror=alert(1)> Meaningful caption'}]);
  assert.equal(segment.end, 11);
  assert.ok(segment.text.includes('<img'));
  assert.equal(cacheKey({id:'segment-0-0',text:'Words.'}, 'abcdefghijk'),
    'abcdefghijk:zh:clean1:semantic:segment-0-0:Words.');
});

test('Japanese captions join kana and kanji without artificial spaces or changing their wording', () => {
  const entries = [
    {start:0,duration:2,language:'ja',text:'今日は新しいパソコンを'},
    {start:2,duration:2,language:'ja',text:'紹介します。とても'},
    {start:4,duration:2,language:'ja',text:'静かです。'},
  ];
  const original = structuredClone(entries);
  const [segment] = buildPlaybackSegments(entries);
  assert.equal(segment.text, '今日は新しいパソコンを紹介します。とても静かです。');
  assert.equal(segment.id, 'segment-0-0');
  assert.equal(segment.start, 0);
  assert.equal(segment.end, 6);
  assert.deepEqual(entries, original);
  assert.equal(cacheKey(segment, 'abcdefghijk'),
    `abcdefghijk:zh:clean1:semantic:segment-0-0:${segment.text}`);
});

test('Japanese grouping can infer kana when language is absent and handles language regions', () => {
  for (const language of [undefined, 'ja-JP', 'ja_JP', 'jpn']) {
    const [segment] = groupTranscriptEntries([
      {start:0,duration:1,language,text:'これは'},
      {start:1,duration:1,language,text:'テストです。'},
    ]);
    assert.equal(segment.text, 'これはテストです。', String(language));
  }
  // An explicitly English track is not reinterpreted just because it quotes Japanese.
  assert.equal(groupTranscriptEntries([
    {start:0,duration:1,language:'en',text:'これは'},
    {start:1,duration:1,language:'en',text:'テストです。'},
  ])[0].text, 'これは テストです。');
});

test('Japanese clause punctuation forms natural bounded segments without affecting Chinese or English fixtures', () => {
  const text = 'これは新しいパソコンで、音がとても静かなので、毎日の仕事に使えます。';
  const parts = splitOversizedThought(text, 20, true);
  assert.equal(parts.join(''), text);
  assert.ok(parts[0].endsWith('、'));
  assert.ok(parts.every((part) => part.length <= 20));
  const segments = groupTranscriptEntries([{start:0,duration:12,language:'ja',text}],
    {minChars:8,idealChars:12,maxChars:20,maxSeconds:20});
  assert.ok(segments.length > 1);
  assert.equal(segments.map((segment) => segment.text).join(''), text);
  assert.ok(segments[0].text.endsWith('、'));
});

test('Korean caption boundaries preserve word spacing and English names instead of joining Hangul', () => {
  const entries = [
    {start:0,duration:2,language:'ko',text:'[음악] 오늘은 새 노트북을'},
    {start:2,duration:2,language:'ko-KR',text:'소개합니다. Chrome 에서'},
    {start:4,duration:2,language:'ko',text:'확인해 볼게요.'},
  ];
  const [segment] = buildPlaybackSegments(entries);
  assert.equal(segment.text, '오늘은 새 노트북을 소개합니다. Chrome 에서 확인해 볼게요.');
  assert.equal(segment.end, 6);
  assert.equal(segment.id, 'segment-0-0');
});

test('short captions separated by a long silence never reveal later dialogue early', () => {
  for (const [language, first, second] of [
    ['en', 'Hello.', 'Thanks.'], ['ja', 'こんにちは。', 'ありがとう。'], ['ko', '안녕하세요.', '감사합니다.'],
  ]) {
    const entries = [
      {start:0,duration:2,language,text:first},
      {start:2,duration:28,language,text:'[music]'},
      {start:30,duration:2,language,text:second},
    ];
    const playback = buildPlaybackSegments(entries);
    assert.equal(playback.length, 2, language);
    assert.deepEqual(playback.map(({start,end,text}) => ({start,end,text})), [
      {start:0,end:2,text:first}, {start:30,end:32,text:second},
    ]);
    assert.deepEqual(groupTranscriptEntries(entries).map(({id,text}) => ({id,text})),
      playback.map(({id,text}) => ({id,text})));
  }
});
