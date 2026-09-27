import test from 'node:test';
import assert from 'node:assert/strict';
import { createFacebookRequestLimiter, FACEBOOK_COOLDOWN_MS, configureFacebookCooldown } from '../src/facebookRequestLimiter.js';
import { FacebookGraphqlClient, formatFacebookError } from '../src/facebookGraphqlClient.js';
import { createFacebookConnector } from '../src/facebookConnector.js';
import { loadConfig } from '../src/config.js';

function fakeLimiter() {
  let time = 0;
  return { now: () => time, advance: ms => {time += ms;}, schedule: createFacebookRequestLimiter({now: () => time, sleep: async ms => {time += ms;}}) };
}

test('concurrent callers share spacing, including after a network failure', async () => {
  const clock = fakeLimiter();
  const starts = [];
  const results = await Promise.allSettled([0,1,2,3].map(i => clock.schedule(() => {
    starts.push(clock.now());
    if (i === 1) throw new Error('network failure');
    return i;
  }, 3)));
  assert.deepEqual(starts, [0,20000,40000,60000]);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[3].value, 3);
});

test('429 rejects queued work, honors longer Retry-After, and allows a later request', async () => {
  const clock = fakeLimiter();
  await assert.rejects(clock.schedule(() => new Response('', {status:429, headers:{'retry-after':'7200'}})), {code:'FACEBOOK_COOLDOWN'});
  let calls = 0;
  await assert.rejects(clock.schedule(() => {calls++;}), {code:'FACEBOOK_COOLDOWN'});
  assert.equal(calls,0);
  clock.advance(7200000);
  await clock.schedule(() => {calls++;});
  assert.equal(calls,1);
});

test('429 honors a shorter server Retry-After instead of imposing the fallback hour', async () => {
  const clock = fakeLimiter();
  await assert.rejects(clock.schedule(() => new Response('', {status:429, headers:{'retry-after':'60'}})), {code:'FACEBOOK_COOLDOWN'});
  assert.equal((await clock.schedule.status()).retryAt, new Date(60000).toISOString());
  clock.advance(60000);
  await clock.schedule(() => new Response('ok'));
});

test('configured limit reaches the connector; invalid limits fail early', () => {
  const config = loadConfig({FB_MAX_REQUESTS_PER_MINUTE:'7'});
  const connector = createFacebookConnector({mode:'facebook_graphql', facebookMaxRequestsPerMinute:config.facebookMaxRequestsPerMinute});
  assert.equal(connector.client.requestsPerMinute,7);
  for (const rate of [0,-1,'bad',Infinity]) assert.throws(() => new FacebookGraphqlClient({facebookMaxRequestsPerMinute:rate}), /positive number/);
});

test('Facebook error details redact session credentials and links', () => {
  const message = formatFacebookError({errors:[{code:1675004,message:'Rejected secret-xs page-token https://facebook.com/?token=private'}]}, {cookieHeader:'xs=secret-xs',fbDtsg:'page-token'});
  assert.match(message,/1675004/);
  assert.doesNotMatch(message,/secret-xs|page-token|private/);
  assert.match(formatFacebookError({error:1357004,errorDescription:'Please log in'}),/1357004: Please log in/);
});

test('page and GraphQL calls use the same limiter and rejection clears the session', async t => {
  const clock = fakeLimiter();
  const requests = [];
  t.mock.method(globalThis, 'fetch', async url => {
    requests.push({url,time:clock.now()});
    return String(url).includes('/api/graphql/')
      ? new Response(JSON.stringify({errors:[{code:123,message:'Query denied'}]}))
      : new Response('"DTSGInitData",[],{"token":"page-token"}');
  });
  const client = new FacebookGraphqlClient({useChromeCookies:false,scheduleRequest:clock.schedule});
  await assert.rejects(client.searchListings({query:'car',latitude:1,longitude:2,limit:1}), /123: Query denied/);
  assert.deepEqual(requests.map(r => r.time),[0,6000]);
  assert.equal(client.session,null);
});

test('concurrent session creation fetches tokens once', async () => {
  const client = new FacebookGraphqlClient({useChromeCookies:false});
  let calls = 0;
  client.extractTokens = async () => {calls++; return {fbDtsg:'token'};};
  await Promise.all([client.ensureSession(),client.ensureSession()]);
  assert.equal(calls,1);
});

test('HTTP 200 Facebook rate limit blocks all queued clients before their fetch', async () => {
  const clock = fakeLimiter();
  let calls = 0;
  const result = await Promise.allSettled([
    clock.schedule(() => { calls++; return new Response('for (;;);'+JSON.stringify({errors:[{code:1675004,message:'Rate limit exceeded'}]}), {headers:{'content-type':'application/json'}}); }),
    clock.schedule(() => { calls++; return new Response('{}'); }),
    clock.schedule(() => { calls++; return new Response('{}'); })
  ]);
  assert.equal(calls,1);
  assert.ok(result.every(r=>r.status==='rejected' && r.reason.code==='FACEBOOK_COOLDOWN'));
  assert.equal(result[0].reason.retryAt,FACEBOOK_COOLDOWN_MS);
});

test('cooldown persists across limiter restarts, and repeated clicks do not extend it', async () => {
  let persisted = 0;
  const store = {read:async()=>persisted,write:async until=>{persisted=until;}};
  const first = createFacebookRequestLimiter({now:()=>1000,store});
  await assert.rejects(first(()=>new Response(JSON.stringify({error:1675004,errorDescription:'Rate limit exceeded'}))),{code:'FACEBOOK_COOLDOWN'});
  const second = createFacebookRequestLimiter({now:()=>2000,store});
  let calls=0;
  await assert.rejects(second(()=>{calls++;}),{code:'FACEBOOK_COOLDOWN'});
  assert.equal(calls,0);
  assert.equal(persisted,1000+FACEBOOK_COOLDOWN_MS);
});

test('other GraphQL errors do not create a rate-limit cooldown', async () => {
  const clock=fakeLimiter();
  await clock.schedule(()=>new Response(JSON.stringify({errors:[{code:123,message:'Invalid query'}]})));
  let called=false;
  await clock.schedule(()=>{called=true;});
  assert.equal(called,true);
});

test('startup restores a recent rate limit into persistent storage', async () => {
  const calls=[];
  const db={pool:{query:async(sql,params)=>{
    calls.push({sql,params});
    return {rows:sql.includes('MAX(finished_at)')?[{last_limited_at:new Date('2026-09-26T23:00:00Z')}]:[]};
  }}};
  await configureFacebookCooldown(db);
  assert.equal(calls.length,2);
  assert.equal(calls[1].params[0],Date.parse('2026-09-27T00:00:00Z'));
});

test('detail rejection does not trigger a photo request; existing gallery avoids extra request', async () => {
  const client=new FacebookGraphqlClient({useChromeCookies:false});
  let calls=0;
  client.graphqlRequest=async()=>{calls++;throw new Error('limited');};
  await assert.rejects(client.getListingDetail('123'),/limited/);
  assert.equal(calls,1);
  calls=0;
  client.graphqlRequest=async()=>{calls++;return {data:{viewer:{marketplace_product_details_page:{target:{id:'123',listing_photos:[{image:{uri:'https://example.com/a.jpg'}},{image:{uri:'https://example.com/b.jpg'}}]}}}}};};
  const detail=await client.getListingDetail('123');
  assert.equal(calls,1);
  assert.equal(detail.images.length,2);
});

test('detail requests fetch the scoped photo gallery when the listing has no photos', async () => {
  const client=new FacebookGraphqlClient({useChromeCookies:false});
  const calls=[];
  client.graphqlRequest=async(docId)=>{
    calls.push(docId);
    if (calls.length === 1) return {data:{viewer:{marketplace_product_details_page:{target:{id:'123',marketplace_listing_title:'2020 Chevrolet Corvette'}}}}};
    return {data:{viewer:{marketplace_product_details_page:{target:{listing_photos:[{image:{uri:'https://example.com/corvette.jpg'}}]}}}}};
  };

  const detail=await client.getListingDetail('123');

  assert.equal(calls.length,2);
  assert.notEqual(calls[0],calls[1]);
  assert.deepEqual(detail.images,['https://example.com/corvette.jpg']);
  assert.equal(detail.imageUrl,'https://example.com/corvette.jpg');
});
