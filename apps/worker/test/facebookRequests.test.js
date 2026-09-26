import test from 'node:test';
import assert from 'node:assert/strict';
import { createFacebookRequestLimiter } from '../src/facebookRequestLimiter.js';
import { FacebookGraphqlClient, formatFacebookError } from '../src/facebookGraphqlClient.js';
import { createFacebookConnector } from '../src/facebookConnector.js';
import { loadConfig } from '../src/config.js';

function fakeLimiter() {
  let time = 0;
  return { now: () => time, schedule: createFacebookRequestLimiter({now: () => time, sleep: async ms => {time += ms;}}) };
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

test('429 respects Retry-After without automatically repeating the rejected request', async () => {
  const clock = fakeLimiter();
  await clock.schedule(() => new Response('', {status:429, headers:{'retry-after':'120'}}));
  await clock.schedule(() => assert.equal(clock.now(), 120000));
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
  assert.deepEqual(requests.map(r => r.time),[0,20000]);
  assert.equal(client.session,null);
});

test('concurrent session creation fetches tokens once', async () => {
  const client = new FacebookGraphqlClient({useChromeCookies:false});
  let calls = 0;
  client.extractTokens = async () => {calls++; return {fbDtsg:'token'};};
  await Promise.all([client.ensureSession(),client.ensureSession()]);
  assert.equal(calls,1);
});
