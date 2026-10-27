const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const VIDEO = 'abcdefghijk';
const OTHER = 'lmnopqrstuv';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
function fixture(send = async () => ({success:true})) {
  const calls=[];
  const context=vm.createContext({console,URL,YTD_TRANSCRIPT_SEGMENTS:{},setTimeout,clearTimeout,setInterval,clearInterval,
    window:{addEventListener(){},close(){calls.push(['close']);}},
    document:{addEventListener(){},getElementById:()=>null,querySelectorAll:()=>[],querySelector:()=>null},
    chrome:{runtime:{onMessage:{addListener(){}},sendMessage:async m=>{calls.push(['message',m]);return send(m);}},
      windows:{getCurrent:async()=>({id:7})},
      tabs:{onUpdated:{addListener(){}},onActivated:{addListener(){}},sendMessage:async(...args)=>calls.push(['direct',...args])}},
    calls});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../sidepanel.js'),'utf8'),context);
  const run = code=>vm.runInContext(code,context);
  run(`currentVideoId='${VIDEO}';youtubeTabId=21;panelIsShowingResults=()=>true;
    scheduleDigestRefresh=()=>calls.push(['refresh']);
    renderNotes=(notes,videoId)=>calls.push(['notes',notes,videoId]);
    setTranscriptModeButtons=mode=>calls.push(['mode',mode]);
    setTranslatingSpinner=()=>{};renderTranscript=()=>calls.push(['render']);
    translateTranscript=async()=>calls.push(['translate']);`);
  return {context,calls,run};
}

test('switching to another tab with the same video refreshes its tab binding',()=>{
  const f=fixture();
  f.run(`handleFrontTabUrl('https://www.youtube.com/watch?v=${VIDEO}',22)`);
  assert.equal(f.calls.filter(c=>c[0]==='refresh').length,1);
});

test('timestamp seeks always use the video/window validated relay, including during navigation',async()=>{
  const f=fixture(async()=>({success:false,error:'video changed'}));
  await f.run('panelWindowReady');
  await f.run('seekTo(85)');
  assert.equal(f.calls.some(c=>c[0]==='direct'),false);
  const request=f.calls.find(c=>c[0]==='message')[1];
  assert.equal(request.action,'relayToContent');
  assert.equal(request.videoId,VIDEO);assert.equal(request.tabId,21);assert.equal(request.windowId,7);
  assert.equal(request.payload.seconds,85);
});

test('late note reads cannot replace a newer filter or a newly opened video',async()=>{
  const first=deferred();const f=fixture(m=>m.videoId===VIDEO?first.promise:Promise.resolve({success:true,notes:[{id:'new'}]}));
  const old=f.run(`loadNotes('${VIDEO}')`);
  await f.run('loadNotes(null)');
  first.resolve({success:true,notes:[{id:'old'}]});await old;
  assert.equal(f.run('currentNotes[0].id'),'new');
  assert.equal(f.run('currentNotesFilterVideoId'),null);
  assert.equal(f.calls.filter(c=>c[0]==='notes').length,1);
  const late=deferred();const f2=fixture(()=>late.promise);
  const pending=f2.run(`loadNotes('${VIDEO}')`);
  f2.run(`currentVideoId='${OTHER}';`);
  late.resolve({success:true,notes:[{id:'old'}]});await pending;
  assert.equal(f2.calls.some(c=>c[0]==='notes'),false);
});

test('display mode updates immediately and old persistence cannot overwrite a newer choice',async()=>{
  const slow=deferred();const f=fixture();f.context.slow=slow.promise;
  f.run(`saveDisplayLanguageMode=async(id,mode)=>mode==='zh'?slow:undefined;`);
  const a=f.run(`handleDisplayLanguageModeChange('zh')`);
  assert.deepEqual(f.calls.filter(c=>c[0]==='mode').map(c=>c[1]),['zh']);
  await f.run(`handleDisplayLanguageModeChange('original')`);
  slow.resolve();await a;
  assert.equal(f.run('currentTranscriptMode'),'original');
  assert.equal(f.calls.filter(c=>c[0]==='mode').at(-1)[1],'original');
});

test('display-mode storage failure does not prevent rendering the requested mode',async()=>{
  const f=fixture();f.run(`saveDisplayLanguageMode=async()=>{throw new Error('storage unavailable')};`);
  await f.run(`handleDisplayLanguageModeChange('bilingual')`);
  assert.equal(f.calls.filter(c=>c[0]==='mode').at(-1)[1],'bilingual');
  assert.equal(f.calls.some(c=>c[0]==='translate'),true);
});

test('rapid mode persistence keeps the newest choice and preserves other video entries',async()=>{
  const f=fixture();const gate=deferred();const data={};let writes=0;
  f.context.chrome.storage={local:{
    get:async key=>({[key]:structuredClone(data[key])}),
    set:async values=>{ if(++writes===1) await gate.promise;Object.assign(data,structuredClone(values));},
  }};
  const first=f.run(`saveDisplayLanguageMode('${VIDEO}','zh')`);
  await new Promise(r=>setImmediate(r));
  const second=f.run(`saveDisplayLanguageMode('${VIDEO}','bilingual')`);
  const third=f.run(`saveDisplayLanguageMode('${OTHER}','original')`);
  gate.resolve();await Promise.all([first,second,third]);
  const saved=data.ytd_display_language_modes_by_video;
  assert.equal(saved[VIDEO].mode,'bilingual');assert.equal(saved[OTHER].mode,'original');
});

test('an old overview finishing its cache save cannot clear a newer analysis loading flag',async()=>{
  const gate=deferred();const f=fixture(async()=>({success:true,analysis:{keyMoments:[]}}));f.context.gate=gate.promise;
  f.run(`currentTranscriptTimestamped='[0:00] Transcript';currentTrackKey='first-track';
    renderAnalysisResults=()=>{};highlightMomentsOnPage=()=>{};saveToCache=()=>gate;`);
  const pending=f.run('triggerAnalysis()');await new Promise(r=>setImmediate(r));
  f.run(`currentVideoId='${OTHER}';++digestLoadGeneration;isAnalysisLoading=true;`);
  gate.resolve();await pending;
  assert.equal(f.run('isAnalysisLoading'),true);
});
