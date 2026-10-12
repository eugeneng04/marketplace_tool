import test from 'node:test';
import assert from 'node:assert/strict';
import {searchMarketplaceBrowser} from '../src/facebookBrowserSearch.js';

function fixture({viewer='123',html,visibleIds=['123']}={}) {
  let closed=0;
  let visited;
  let cookies;
  const page={goto:async url=>{visited=url;},url:()=>visited,content:async()=>`{"USER_ID":"${viewer}"}${html ?? '<a href="/marketplace/item/123/"><span>$10,000</span><span>Scion FR-S</span><span>Milpitas, CA</span></a>'}`,
    locator:()=>({evaluateAll:async()=>visibleIds}),waitForTimeout:async()=>{throw new Error('Unexpected waiting');}};
  const browser={newContext:async()=>({addCookies:async value=>{cookies=value;},newPage:async()=>page,route:async()=>{},cookies:async()=>[{name:'c_user',value:'123'},{name:'xs',value:'renewed'}]}),close:async()=>{closed++;}};
  return {launch:async()=>browser,closed:()=>closed,visited:()=>visited,cookies:()=>cookies};
}
const params={query:'frs',latitude:37.4,longitude:-121.9,radiusKm:161,minPrice:1000,maxPrice:20000,limit:5};
const schedule=Object.assign(async fn=>fn(),{status:async()=>({paused:false})});

test('browser search collects visible cards with the query URL and updates session cookies privately',async()=>{
  const f=fixture();let cookieHeader;
  const result=await searchMarketplaceBrowser(params,{cookieHeader:'c_user=123; xs=old',schedule,launch:f.launch,onCookieHeader:value=>{cookieHeader=value;}});
  const url=new URL(f.visited());
  assert.equal(url.searchParams.get('query'),'frs');
  assert.equal(url.searchParams.size,1);
  assert.equal(result.diagnostics.queryMatchingCardCount,1);
  assert.equal(result.diagnostics.requestedFiltersVerified,false);
  assert.equal(result.listings[0].title,'Scion FR-S');
  assert.equal(result.diagnostics.cardSource,'marketplace_browser');
  assert.equal(cookieHeader,'c_user=123; xs=renewed');
  assert.equal(JSON.stringify(result).includes('renewed'),false);
  assert.equal(f.closed(),1);
});

test('browser search ignores generic embedded suggestions absent from visible search IDs',async()=>{
  const html='<script type="application/json">{"id":"999","marketplace_listing_title":"Generic car"}</script><a href="/marketplace/item/123/"><span>Scion FR-S</span><span>$10,000</span></a>';
  const f=fixture({html});
  const result=await searchMarketplaceBrowser(params,{cookieHeader:'c_user=123; xs=old',schedule,launch:f.launch});
  assert.equal(result.listings.length,1);assert.equal(result.listings[0].id,'123');
});

test('browser search rejects logged-out viewer and always closes Chromium',async()=>{
  const f=fixture({viewer:'0'});
  await assert.rejects(searchMarketplaceBrowser(params,{cookieHeader:'c_user=123; xs=old',schedule,launch:f.launch}),/session/);
  assert.equal(f.closed(),1);
});

test('browser search honors shared cooldown before launching',async()=>{
  let launched=false;
  const paused=Object.assign(async fn=>fn(),{status:async()=>({paused:true,retryAt:new Date(Date.now()+60000).toISOString()})});
  await assert.rejects(searchMarketplaceBrowser(params,{schedule:paused,launch:async()=>{launched=true;}}),{code:'FACEBOOK_COOLDOWN'});
  assert.equal(launched,false);
});

test('visible cards cannot report success ahead of a delayed upstream throttle',async()=>{
  let handler;
  let closed=0;
  const request={url:()=> 'https://www.facebook.com/api/graphql/',resourceType:()=> 'fetch'};
  const response={request:()=>request,status:()=>429,headers:()=>({}),text:async()=>{await new Promise(resolve=>setTimeout(resolve,15));return '{"errors":[{"code":1675004}]}';}};
  let routeDone;
  const page={goto:async()=>{routeDone=handler({request:()=>request,continue:async()=>{},abort:async()=>{}});},url:()=> 'https://www.facebook.com/marketplace/search/?query=frs',
    waitForResponse:async()=>response,content:async()=>'{"USER_ID":"123"}<a href="/marketplace/item/123/">Scion FR-S $10,000</a>',locator:()=>({evaluateAll:async()=>['123']})};
  const browser={newContext:async()=>({addCookies:async()=>{},newPage:async()=>page,route:async(_pattern,callback)=>{handler=callback;}}),close:async()=>{closed++;}};
  const throttle=Object.assign(async fn=>{const r=await fn();if(r.status===429){const e=new Error('Throttled');e.code='FACEBOOK_COOLDOWN';throw e;}return r;},{status:async()=>({paused:false})});
  await assert.rejects(searchMarketplaceBrowser(params,{cookieHeader:'c_user=123; xs=old',schedule:throttle,launch:async()=>browser}),{code:'FACEBOOK_COOLDOWN'});
  await routeDone;
  assert.equal(closed,1);
});

test('worker client factory preserves browser source for saved profile collection',async()=>{
  const {createFacebookGraphqlClient,createFacebookGraphqlConnector,createFacebookConnector}=await import('../src/facebookConnector.js');
  assert.equal(createFacebookGraphqlClient({facebookSearchSource:'browser'}).searchSource,'browser');
  assert.equal(createFacebookGraphqlConnector({facebookSearchSource:'browser'}).client.searchSource,'browser');
  assert.equal(createFacebookConnector({mode:'facebook_graphql',facebookSearchSource:'browser'}).client.searchSource,'browser');
});

 test('generic visible suggestions cannot complete a saved query search',async()=>{
  const f=fixture({html:'<a href="/marketplace/item/123/">Toyota Corolla $10,000</a>'});
  await assert.rejects(searchMarketplaceBrowser(params,{cookieHeader:'c_user=123; xs=old',schedule,launch:f.launch}),/failed/);
  assert.equal(f.closed(),1);
});

test('punctuation-only query cannot match generic cards',async()=>{
  const f=fixture();
  await assert.rejects(searchMarketplaceBrowser({...params,query:'!!!'},{cookieHeader:'c_user=123; xs=old',schedule,launch:f.launch}),/failed/);
});

test('only query-matching visible cards are returned',async()=>{
  const f=fixture({visibleIds:['123','999'],html:'<a href="/marketplace/item/123/">Scion FR-S $10,000</a><a href="/marketplace/item/999/">Toyota Corolla $10,000</a>'});
  const result=await searchMarketplaceBrowser(params,{cookieHeader:'c_user=123; xs=old',schedule,launch:f.launch});
  assert.deepEqual(result.listings.map(x=>x.id),['123']);
});
