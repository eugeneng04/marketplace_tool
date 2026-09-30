import test from 'node:test';
import assert from 'node:assert/strict';
import {browserCookies, summarizeGraphql, createBrowserDiagnostic, sessionCookieHash, facebookPageCategory, redirectCategory, browserFailureCode, parseMemoryEvents} from '../src/facebookBrowserDiagnostic.js';

test('memory counters only report allowed numeric fields', () => {
  assert.deepEqual(parseMemoryEvents('low 0\noom 3\noom_kill 2\noom_group_kill 0\nsecret abc'),
    {oom:3,oom_kill:2,oom_group_kill:0});
});

test('diagnostic reports container OOM kills during browser execution', async () => {
  let reads=0;
  const schedule=Object.assign(async fn=>fn(),{status:async()=>({paused:false})});
  const diagnostic=createBrowserDiagnostic({config:{facebookCookie:''},schedule,
    readMemory:async()=>({oom_kill:reads++}),launch:async()=>{throw new Error('Browser exited');}});
  await diagnostic.start();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(diagnostic.status().oomKillDelta,1);
});

test('redirect and network summaries omit sensitive URLs and error text', () => {
  assert.equal(redirectCategory('/login/?secret=abc','https://www.facebook.com/marketplace/'),'login_required');
  assert.equal(redirectCategory('https://example.com/?secret=abc','https://www.facebook.com/'),'external_redirect');
  assert.equal(browserFailureCode(new Error('net::ERR_ABORTED at https://secret/')),'ERR_ABORTED');
  assert.equal(browserFailureCode(new Error('cookie=secret')),'unclassified');
  assert.equal(browserFailureCode(new Error('page.goto: Page crashed')),'page_crashed');
  assert.equal(browserFailureCode(new Error('Navigation to secret interrupted by another navigation')),'navigation_interrupted');
});

for (const status of [302,304]) {
  test(`document ${status} does not read its body or abort a continued route`, async () => {
    let handler;
    let aborted=0;
    let bodyReads=0;
    const events={};
    const request={url:()=> 'https://www.facebook.com/marketplace/search/', resourceType:()=> 'document',postData:()=>null};
    const response={request:()=>request,status:()=>status,headers:()=>({'content-type':'text/html',location:'/login/?secret=abc'}),
      text:async()=>{bodyReads++;throw new Error('Redirect body unavailable');}};
    const route={request:()=>request,continue:async()=>{},abort:async()=>{aborted++;}};
    const page={on:(event,callback)=>{events[event]=callback;}, waitForResponse:async()=>response,
      goto:async()=>{await handler(route);},url:()=> 'https://www.facebook.com/login/'};
    const browser={version:()=> 'test',newContext:async()=>({addCookies:async()=>{},newPage:async()=>page,
      route:async(pattern,callback)=>{handler=callback;}}),close:async()=>{}};
    const schedule=Object.assign(async fn=>fn(),{status:async()=>({paused:false})});
    const diagnostic=createBrowserDiagnostic({config:{facebookCookie:'c_user=123; xs=abc',facebookMaxRequestsPerMinute:3},schedule,launch:async()=>browser});
    await diagnostic.start();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(diagnostic.status().state,'finished');
    assert.equal(diagnostic.status().outcome,'login_required');
    assert.equal(diagnostic.status().requests[0].redirectCategory,'login_required');
    assert.equal(diagnostic.status().requestFailure,undefined);
    assert.equal(bodyReads,0);
    assert.equal(aborted,0);
    assert.equal(JSON.stringify(diagnostic.status()).includes('secret'),false);
  });
}

test('session comparison ignores cookie order and unrelated cookies', () => {
  assert.equal(sessionCookieHash('c_user=123; xs=abc; datr=one'),sessionCookieHash('datr=two; xs=abc; c_user=123'));
  assert.notEqual(sessionCookieHash('c_user=123; xs=abc'),sessionCookieHash('c_user=123; xs=def'));
});

test('page categories distinguish login from checkpoint without exposing redirect URLs', () => {
  assert.equal(facebookPageCategory('/login/'),'login_required');
  assert.equal(facebookPageCategory('/checkpoint/123'),'security_checkpoint');
  assert.equal(facebookPageCategory('/marketplace/search/'),'marketplace');
});

test('diagnostic cookies preserve equals signs and are scoped to Facebook', () => {
  assert.deepEqual(browserCookies('c_user=123; xs=a=b; invalid'), [
    {name:'c_user',value:'123',domain:'.facebook.com',path:'/',secure:true},
    {name:'xs',value:'a=b',domain:'.facebook.com',path:'/',secure:true}
  ]);
});

test('diagnostic only reports numeric codes, never error messages or session data', () => {
  const result = summarizeGraphql('for (;;);' + JSON.stringify({errors:[{code:1675004,message:'Rate limit exceeded secret'}],data:null}));
  assert.deepEqual(result,{errorCodes:['1675004'],hasData:false,rateLimited:true});
  assert.equal(JSON.stringify(result).includes('secret'),false);
});

test('diagnostic reads streamed GraphQL responses', () => {
  assert.deepEqual(summarizeGraphql('for (;;);{"data":{"viewer":{}}}\n{"errors":[{"code":123}]}'),
    {errorCodes:['123'],hasData:true,rateLimited:false});
});

test('diagnostic honors the shared cooldown without launching Chromium', async () => {
  let launched = false;
  const schedule = Object.assign(async fn => fn(),{status:async()=>({paused:true,retryAt:'later'})});
  const diagnostic = createBrowserDiagnostic({config:{facebookCookie:''}, schedule, launch:async()=>{launched=true;}});
  assert.deepEqual(await diagnostic.start(),{state:'paused',retryAt:'later'});
  assert.equal(launched,false);
});

test('diagnostic hides launch errors and limits repeated starts', async () => {
  let launches=0;
  const schedule = Object.assign(async fn => fn(),{status:async()=>({paused:false})});
  const diagnostic = createBrowserDiagnostic({config:{facebookCookie:'xs=secret'},schedule,
    launch:async()=>{launches++;throw new Error('xs=secret');}});
  await diagnostic.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(diagnostic.status().outcome,'browser_launch_failed');
  assert.equal(JSON.stringify(diagnostic.status()).includes('secret'),false);
  assert.equal((await diagnostic.start()).state,'paused');
  assert.equal(launches,1);
});
