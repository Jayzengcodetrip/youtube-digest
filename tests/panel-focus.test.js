const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve}; };
const videoA = 'abcdefghijk', videoB = 'lmnopqrstuv';
function fixture(send = async () => ({success:true,response:{currentTime:85}})) {
  const messages = [], frames = [], calls = [];
  const area = {scrollTop:900,classList:{remove(){},toggle(){}},addEventListener(){},removeEventListener(){}};
  const elements = {contentArea:area,followPlaybackBtn:{style:{}},panelSwitchStatus:{hidden:true,textContent:''}};
  const ctx = vm.createContext({console, URL, setTimeout,clearTimeout,setInterval,clearInterval,
    requestAnimationFrame: fn=>frames.push(fn), cancelAnimationFrame(){}, YTD_TRANSCRIPT_SEGMENTS:{},
    document:{addEventListener(){},getElementById:id=>elements[id]||null,querySelectorAll:()=>[],querySelector:()=>null},
    window:{addEventListener(){}},
    chrome:{runtime:{onMessage:{addListener(){}},sendMessage:async m=>{messages.push(m);return send(m);}},
      windows:{getCurrent:async()=>({id:7})},
      tabs:{onUpdated:{addListener(){}},onActivated:{addListener(){}},query:async q=>{calls.push(['query',q]);return [{id:21,windowId:7,active:true,url:'https://www.youtube.com/watch?v='+videoA}];}}},
    calls, elements, fixtureVideoA:videoA});
  vm.runInContext(read('sidepanel.js'),ctx);
  vm.runInContext(`
    panelConfigStatus={hasSupadataKey:true,hasAiKey:true};
    currentVideoId=fixtureVideoA; youtubeTabId=21; currentTranscript=[{text:'text',start:80}];
    const realWaitForViewport = waitForTranscriptViewport;
    waitForTranscriptViewport = async () => true;
    setTranscriptModeButtons=mode=>calls.push(['mode',mode]);
    switchTab=(tab,opts)=>calls.push(['tab',tab,opts]);
    getActiveTranscriptSegments=()=>[{id:'first',start:0},{id:'current',start:80}];
    renderTranscriptModeRows=(segments,mode)=>calls.push(['rows',mode]);
    highlightActiveEntry=time=>calls.push(['highlight',time]);
    scrollToActiveEntry=behavior=>calls.push(['scroll',behavior]);
    translateTranscript=opts=>calls.push(['translate',opts]);
    showConfigError=()=>calls.push(['configError']);
    showState=state=>calls.push(['state',state]);
    transcriptTabIsActive=()=>true;
  `,ctx);
  const run = code=>vm.runInContext(code,ctx);
  const intent = (id='r1', videoId=videoA) => ({requestId:id,source:'subtitle',tabId:21,windowId:7,videoId,createdAt:1});
  return {ctx,run,messages,frames,calls,area,intent,elements};
}
async function focus(f,intent=f.intent()) {
  f.ctx.intent = intent;
  f.run('pendingSubtitleIntent=intent');
  return f.run('applySubtitleIntent(intent)');
}
test('subtitle entry overrides Notes/old reading position and focuses time read AFTER load and bilingual render',async()=>{
  const f=fixture(async m=>{f.calls.push(['message',m.action]); return {success:true,response:{currentTime:85}};});
  await f.run('panelWindowReady');
  f.run(`checkCurrentTab=async()=>{calls.push(['loaded']);return true}; pendingTranscriptViewState={videoId:fixtureVideoA,scrollTop:900}; autoScrollEnabled=false;`);
  await focus(f);
  assert.deepEqual(f.calls.filter(c=>['loaded','mode','rows','highlight','scroll'].includes(c[0])).map(c=>Array.from(c).slice(0,2)),
    [['loaded'],['mode','bilingual'],['rows','bilingual'],['highlight',85],['scroll','instant']]);
  assert.equal(f.run('autoScrollEnabled'),true);
  assert.equal(f.run('pendingTranscriptViewState'),null);
  assert.equal(f.calls.find(c=>c[0]==='translate')[1].reuseRows,true);
  assert.equal(f.calls.find(c=>c[0]==='translate')[1].initialIndex,1);
  assert.equal(f.messages[0].tabId,21);assert.equal(f.messages[0].windowId,7);assert.equal(f.messages[0].videoId,videoA);
  assert.ok(f.messages.some(m=>m.action==='ackTranscriptPanelIntent'));
  assert.ok(!f.messages.some(m=>/seek|pause|playbackRate/.test(m.action)));
});
test('already queued reading-position restore cannot beat explicit subtitle focus',async()=>{
  const f=fixture();await f.run('panelWindowReady');
  f.run(`pendingTranscriptViewState={videoId:fixtureVideoA,scrollTop:1234}; restorePendingTranscriptViewState(fixtureVideoA); checkCurrentTab=async()=>true;`);
  await focus(f);f.frames.forEach(fn=>fn());
  assert.equal(f.area.scrollTop,900);assert.equal(f.run('autoScrollEnabled'),true);
});
test('late current-time result cannot focus a newly selected video',async()=>{
  const d=deferred();const f=fixture(m=>m.action==='relayToContent'?d.promise:Promise.resolve({success:true}));
  await f.run('panelWindowReady');f.run('checkCurrentTab=async()=>true');
  const p=focus(f);await new Promise(r=>setImmediate(r));
  f.run(`currentVideoId='${videoB}'; ++transcriptViewGeneration; pendingSubtitleIntent=null;`);
  d.resolve({success:true,response:{currentTime:85}});await p;
  assert.ok(!f.calls.some(c=>c[0]==='highlight'));
  assert.ok(!f.messages.some(m=>m.action==='ackTranscriptPanelIntent'));
});
test('panel focus rejects wrong window and deduplicates ready/broadcast requests',async()=>{
  const f=fixture();await f.run('panelWindowReady');f.run('panelInitialized=false');
  f.ctx.foreign={...f.intent(),windowId:8};f.run('queueSubtitleIntent(foreign)');assert.equal(f.run('pendingSubtitleIntent'),null);
  f.ctx.intent=f.intent();f.run('queueSubtitleIntent(intent)');f.run('checkCurrentTab=async()=>true');
  await f.run('applySubtitleIntent(intent)');await f.run('applySubtitleIntent(intent)');
  assert.equal(f.calls.filter(c=>c[0]==='highlight').length,1);
});
test('missing config still consumes the intent and keeps a usable error state',async()=>{
  const f=fixture();await f.run('panelWindowReady');f.run('panelConfigStatus={hasAiKey:false,hasSupadataKey:false}');
  await focus(f);assert.ok(f.calls.some(c=>c[0]==='configError'));
  assert.ok(f.messages.some(m=>m.action==='ackTranscriptPanelIntent'));
  assert.ok(!f.calls.some(c=>c[0]==='translate'));
});
test('current-time failure reports retry and never guesses zero',async()=>{
  const f=fixture(async()=>({success:false,error:'navigated'}));await f.run('panelWindowReady');f.run('checkCurrentTab=async()=>true');
  await focus(f);assert.match(f.elements.panelSwitchStatus.textContent,/重试/);
  assert.ok(!f.calls.some(c=>c[0]==='highlight'));
});
test('metadata response from older tab check cannot overwrite newer video metadata',async()=>{
  const d=deferred();let count=0;
  const f=fixture(async m=> ++count===1?d.promise:{success:true,response:{title:'new title'}});await f.run('panelWindowReady');
  f.run('startDigest=async(id)=>calls.push(["digest",id])');
  const old=f.run('checkCurrentTab()');await new Promise(r=>setImmediate(r));
  f.ctx.chrome.tabs.query=async()=>[{id:22,windowId:7,url:'https://www.youtube.com/watch?v='+videoB}];
  await f.run('checkCurrentTab()');d.resolve({success:true,response:{title:'OLD'}});await old;
  assert.equal(f.run('currentVideoTitle'),'new title');assert.equal(f.calls.filter(c=>c[0]==='digest').length,1);
  assert.equal(f.messages[0].windowId,7);assert.equal(f.messages[1].tabId,22);
});
test('older polling reply cannot undo a newer seek position',async()=>{
  const d=deferred();let n=0;const f=fixture(async()=>++n===1?d.promise:{success:true,response:{currentTime:150}});
  await f.run('panelWindowReady');const p=f.run('playbackTrackingTick()');await f.run('playbackTrackingTick()');
  d.resolve({success:true,response:{currentTime:20}});await p;
  assert.deepEqual(f.calls.filter(c=>c[0]==='highlight').map(c=>Array.from(c)),[['highlight',150]]);
});

function prepareStartup(f, url = 'chrome-extension://digest-extension/sidepanel.html?ytd-panel=12345678-1234-1234-1234-123456789abc') {
  f.ctx.window.location={href:url,replace:value=>f.calls.push(['navigate',value])};
  f.ctx.crypto={randomUUID:()=> '12345678-1234-1234-1234-123456789abc'};
  f.elements.errorBtn={textContent:''};
  f.run(`updateLoading=()=>{}; evictOldCacheEntries=async()=>{};
    showError=(title,message)=>{calls.push(['error',title,message]);errorAction=null};
    checkCurrentTab=async()=>{calls.push(['loaded']);return true};`);
}
test('native panel gets a distinct committed URL before sending its readiness message', async()=>{
  const f=fixture();await f.run('panelWindowReady');prepareStartup(f,'chrome-extension://digest-extension/sidepanel.html');
  await f.run('initializePanelConnection()');
  assert.equal(f.calls.find(c=>c[0]==='navigate')?.[1], 'chrome-extension://digest-extension/sidepanel.html?ytd-panel=12345678-1234-1234-1234-123456789abc');
  assert.ok(!f.messages.some(m=>m.action==='transcriptPanelReady'));
});
test('panel with unique committed URL handshakes without a second navigation', async()=>{
  const f=fixture(async m=>m.action==='checkConfig'?{hasAiKey:true,hasSupadataKey:true}:{success:true});
  await f.run('panelWindowReady');prepareStartup(f);await f.run('initializePanelConnection()');
  assert.equal(f.run('panelInitialized'),true);assert.ok(!f.calls.some(c=>c[0]==='navigate'));
  assert.equal(f.messages[0].action,'transcriptPanelReady');assert.equal(f.messages[0].windowId,7);
});
test('startup handshake failure shows exact reason and the same panel can retry successfully', async()=>{
  let failure=true;
  const f=fixture(async m=>m.action==='transcriptPanelReady'&&failure?{success:false,error:'测试连接失败'}:m.action==='checkConfig'?{hasAiKey:true,hasSupadataKey:true}:{success:true});
  await f.run('panelWindowReady');prepareStartup(f);await f.run('initializePanelConnection()');
  assert.equal(f.run('panelInitialized'),false);assert.equal(f.elements.errorBtn.textContent,'重试连接');
  assert.ok(f.calls.some(c=>c[0]==='error'&&c[2].includes('测试连接失败')));
  failure=false;await f.run('errorAction()');assert.equal(f.run('panelInitialized'),true);
  assert.equal(f.calls.filter(c=>c[0]==='loaded').length,1);
});
test('repeated startup retries share one handshake instead of racing duplicate loads', async()=>{
  const gate=deferred();const f=fixture(async m=>m.action==='transcriptPanelReady'?gate.promise:{hasAiKey:true,hasSupadataKey:true});
  await f.run('panelWindowReady');prepareStartup(f);const a=f.run('initializePanelConnection()'),b=f.run('initializePanelConnection()');
  assert.equal(a,b);gate.resolve({success:true});await a;assert.equal(f.calls.filter(c=>c[0]==='loaded').length,1);
});
test('ready intent is queued until configuration is ready and then applied once',async()=>{
  const gate=deferred();const f=fixture(async m=>m.action==='transcriptPanelReady'?{success:true,intent:f.intent()}:gate.promise);
  await f.run('panelWindowReady');prepareStartup(f);
  f.run(`applySubtitleIntent=async intent=>{calls.push(['apply',intent.requestId]);pendingSubtitleIntent=null;}`);
  const promise=f.run('initializePanelConnection()');await new Promise(r=>setImmediate(r));
  assert.equal(f.run('pendingSubtitleIntent.requestId'),'r1');assert.ok(!f.calls.some(c=>c[0]==='apply'));
  gate.resolve({hasAiKey:true,hasSupadataKey:true});await promise;
  assert.equal(f.calls.filter(c=>c[0]==='apply').length,1);
});

test('native panel focus waits through a zero-width viewport and a changing layout',async()=>{
  const f=fixture();let width=0;f.area.getBoundingClientRect=()=>({width,height:500});f.ctx.window.innerWidth=0;f.ctx.window.innerHeight=500;
  let resolved=false;const ready=f.run('realWaitForViewport(()=>true)').then(value=>{resolved=true;return value});
  f.frames.shift()();await Promise.resolve();assert.equal(resolved,false);
  width=200;f.ctx.window.innerWidth=200;f.frames.shift()();await Promise.resolve();assert.equal(resolved,false);
  width=360;f.ctx.window.innerWidth=360;f.frames.shift()();await Promise.resolve();assert.equal(resolved,false);
  f.frames.shift()();assert.equal(await ready,true);
});
test('closing or replacing a focus request cancels its pending layout wait',async()=>{
  const f=fixture();f.area.getBoundingClientRect=()=>({width:0,height:500});f.ctx.window.innerWidth=0;f.ctx.current=true;
  const ready=f.run('realWaitForViewport(()=>current)');f.ctx.current=false;f.frames.shift()();assert.equal(await ready,false);
});
