import test from 'node:test';
import assert from 'node:assert/strict';
import {browserCookies, summarizeGraphql, createBrowserDiagnostic} from '../src/facebookBrowserDiagnostic.js';

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
