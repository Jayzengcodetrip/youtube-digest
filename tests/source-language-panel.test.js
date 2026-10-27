const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const videoId = 'abcdefghijk';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(send = async () => ({ success: true })) {
  const calls = [], listeners = [], store = {};
  const elements = Object.fromEntries(['sourceLanguageControl', 'sourceLanguageSelect', 'sourceLanguageStatus',
    'panelSwitchStatus', 'contentArea', 'followPlaybackBtn', 'tabsNav'].map(id => [id, {
    hidden:false, style:{}, value:'auto', textContent:'', classList:{remove(){},toggle(){}},
  }]));
  const event = { addListener() {} };
  const ctx = vm.createContext({ console, URL, setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame:fn=>fn(), cancelAnimationFrame(){},
    window:{addEventListener(){}},
    document:{addEventListener(){},getElementById:id=>elements[id]||null,querySelectorAll:()=>[],querySelector:()=>null},
    chrome:{runtime:{id:'own',onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:async m=>{calls.push(m);return send(m);}},
      windows:{getCurrent:async()=>({id:7})},tabs:{onUpdated:event,onActivated:event},
      storage:{local:{get:async key=>{calls.push({read:key});return {[key]:store[key]};}},session:{get:async()=>({}),set:async()=>{}}}},
    calls, fixtureVideoId:videoId,
  });
  for (const file of ['transcript-cleanup.js','transcript-segments.js','sidepanel.js']) vm.runInContext(read(file),ctx);
  const run = source => vm.runInContext(source, ctx);
  run(`currentVideoId=fixtureVideoId; currentVideoUrl='https://www.youtube.com/watch?v='+fixtureVideoId;
    youtubeTabId=21; currentTrackKey='track-en';
    currentSourceLanguage={preference:'auto',language:'en',reason:'fallback'};
    currentTranscript=[{start:0,duration:5,text:'English source.'}];
    setTranscriptModeButtons=mode=>calls.push({mode});
    showState=state=>calls.push({state}); updateLoading=()=>{};
    showError=(title,message)=>calls.push({errorTitle:title,error:message});
    saveDisplayLanguageMode=async()=>{}; resetTranscriptSearch=()=>{};
    loadTranscriptViewState=async()=>null; loadDisplayLanguageMode=async()=> 'original';
    renderTranscript=()=>calls.push({render:true}); restorePendingTranscriptViewState=()=>{};
    loadNotes=()=>{}; setupExplainFeature=()=>{};
    switchTab=tab=>calls.push({tab}); getActiveTranscriptSegments=()=>[{id:'first',start:0},{id:'current',start:80}];
    renderTranscriptModeRows=()=>calls.push({rows:true}); waitForTranscriptViewport=async()=>true;
    highlightActiveEntry=time=>calls.push({highlight:time}); scrollToActiveEntry=()=>calls.push({scroll:true});
    translateTranscript=opts=>calls.push({translate:opts});`);
  return {ctx,run,calls,elements,store,listeners};
}

test('source language selector exposes automatic, English, Japanese and Korean independently from display mode', () => {
  const html = read('sidepanel.html');
  assert.match(html, /<label for="sourceLanguageSelect">原文语言<\/label>/);
  for (const value of ['auto','en','ja','ko']) assert.match(html, new RegExp(`<option value="${value}">`));
  const f = fixture();
  assert.equal(f.run(`sourceLanguageStatusText({preference:'auto',language:'en',reason:'fallback'})`), '原声未确定 · 当前字幕：英语');
  assert.equal(f.run(`sourceLanguageStatusText({preference:'auto',language:'ja',reason:'original-track'})`), '自动识别：日语');
  assert.equal(f.run(`sourceLanguageStatusText({preference:'ko',language:'ko',reason:'manual'})`), '当前字幕：韩语');
});

test('cache reads first resolve the current tab source and reject a different cached track', async () => {
  const f = fixture(async()=>({success:true,trackKey:'track-ko',transcript:[{text:'한국어',start:0}]}));
  f.store[`digest_${videoId}`]={timestamp:Date.now(),transcriptTrackKey:'track-en',transcript:[{text:'Wrong English.',start:0}]};
  assert.equal(await f.run('loadFromCache(fixtureVideoId)'),null);
  assert.equal(f.calls[0].action,'fetchTranscript');
  assert.equal(f.calls[0].tabId,21);
  assert.equal(f.calls[1].read,`digest_${videoId}`);
});

test('track resolution failure never falls back to a cached English digest', async () => {
  const f=fixture(async()=>({success:false,error:'SOURCE_LANGUAGE_UNAVAILABLE',message:'没有韩语字幕，请选择其他语言。'}));
  f.store[`digest_${videoId}`]={timestamp:Date.now(),transcript:[{text:'Old English',start:0}]};
  await assert.rejects(f.run('loadFromCache(fixtureVideoId)'),/没有韩语字幕/);
  assert.ok(!f.calls.some(call=>call.read));
});

test('same-video forced reload bypasses existing analysis and reuses its single track fetch', async () => {
  const f = fixture(async m => m.action==='fetchTranscript'
    ? {success:true,trackKey:'track-ko',sourceLanguage:{preference:'ko',language:'ko',reason:'manual'},
      transcript:[{text:'안녕하세요.',start:0}],transcriptText:'안녕하세요.',transcriptTextTimestamped:'[0:00] 안녕하세요.',language:'ko'}
    : {success:true});
  f.run(`currentAnalysis={summary:'old overview'};`);
  await f.run('startDigest(fixtureVideoId,currentVideoUrl,{reload:true})');
  assert.equal(f.calls.filter(call=>call.action==='fetchTranscript').length,1);
  assert.equal(f.run('currentTrackKey'),'track-ko');
  assert.equal(f.run('currentTranscript[0].text'),'안녕하세요.');
  assert.equal(f.run('currentAnalysis'),null);
  const saved=f.calls.find(call=>call.action==='saveDigestCache');
  assert.equal(saved.trackKey,'track-ko');
  assert.equal(saved.patch.transcriptTrackKey,'track-ko');
});

test('language switching forces bilingual and locates the latest playback time without seeking or pausing', async () => {
  const f=fixture(async()=>({success:true,response:{currentTime:85}}));
  f.run(`startDigest=async(id,url,opts)=>{calls.push({load:opts}); currentTrackKey='track-ja';};`);
  await f.run('reloadSourceLanguageTranscript(fixtureVideoId,21)');
  assert.equal(f.run('currentTranscriptMode'),'bilingual');
  assert.equal(f.run('autoScrollEnabled'),true);
  assert.equal(f.calls.find(call=>call.load)?.load.reload,true);
  assert.equal(f.calls.find(call=>call.highlight)?.highlight,85);
  assert.equal(f.calls.find(call=>call.translate)?.translate.initialIndex,1);
  assert.ok(!f.calls.some(call=>/seek|pause|playbackRate/.test(call.action||'')));
  assert.equal(f.calls.findIndex(call=>call.rows)<f.calls.findIndex(call=>call.action==='relayToContent'),true);
});

test('own set callback and immediate or delayed broadcasts produce only one track reload', async () => {
  let f;
  f=fixture(async m=>{
    if(m.action==='setSubtitleSourceLanguage') {
      await f.run(`handleSubtitleSourceChanged({videoId:fixtureVideoId})`);
      return {success:true,sourceLanguage:{preference:'ja',language:'ja',reason:'manual'}};
    }
    if(m.action==='getSubtitleSourceLanguage') return {success:true,preference:'ja',language:'ja',reason:'manual'};
    return {success:true};
  });
  f.run(`reloadSourceLanguageTranscript=async()=>{calls.push({reload:true});currentTrackKey='track-ja';};`);
  await f.run(`handleSourceLanguageChange('ja')`);
  await f.run(`handleSubtitleSourceChanged({videoId:fixtureVideoId})`);
  assert.equal(f.calls.filter(call=>call.reload).length,1);
  assert.equal(f.elements.sourceLanguageSelect.disabled,false);
});

test('another video broadcast is ignored and navigation invalidates an in-flight manual language change', async () => {
  const d=deferred();const f=fixture(()=>d.promise);
  await f.run(`handleSubtitleSourceChanged({videoId:'lmnopqrstuv'})`);
  assert.equal(f.calls.length,0);
  f.run(`reloadSourceLanguageTranscript=async()=>calls.push({reload:true});`);
  const pending=f.run(`handleSourceLanguageChange('ko')`);
  f.run(`currentVideoId='lmnopqrstuv'; youtubeTabId=22;`);
  d.resolve({success:true});await pending;
  assert.ok(!f.calls.some(call=>call.reload));
});

test('source selector exposes the human readable service error and can be used again', async () => {
  const f=fixture(async()=>({success:false,error:'SOURCE_LANGUAGE_UNAVAILABLE',message:'此视频没有日语字幕。'}));
  await f.run(`handleSourceLanguageChange('ja')`);
  assert.equal(f.elements.sourceLanguageStatus.textContent,'此视频没有日语字幕。');
  assert.equal(f.elements.sourceLanguageSelect.disabled,false);
});

test('an obsolete active track refreshes once and cannot create an automatic retry loop', async () => {
  const f=fixture(async()=>({success:false,error:'SUBTITLE_TRACK_CHANGED'}));
  f.run(`currentTranscriptMode='bilingual'; reloadSourceLanguageTranscript=async()=>calls.push({reload:true});`);
  await f.run(`requestTranscriptTranslationBatch([0],[{id:'first',start:0,text:'English.'}],0,fixtureVideoId,'bilingual')`);
  await f.run(`requestTranscriptTranslationBatch([0],[{id:'first',start:0,text:'English.'}],0,fixtureVideoId,'bilingual')`);
  assert.equal(f.calls.filter(call=>call.reload).length,1);
  assert.match(f.elements.panelSwitchStatus.textContent,/重新选择/);
  assert.ok(!f.calls.some(call=>call.action==='saveDigestCache'));
});
