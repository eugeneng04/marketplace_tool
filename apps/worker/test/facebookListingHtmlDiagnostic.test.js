import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectListingHtml } from '../src/facebookListingHtmlDiagnostic.js';

const listingId = '1368882882971991';
const target = { id: listingId, marketplace_listing_title: '2017 BMW 340i',
  redacted_description: { text: 'Salvage title. Airbag warning light.' },
  listing_price: { amount: '18000.00' } };
const page = value => `<script type="application/json" data-sjs>${JSON.stringify(value)}</script>`;
const schedule = operation => operation();

test('HTML diagnostic targets the requested listing and sends no credentials or GraphQL requests', async () => {
  let calls = 0;
  const result = await inspectListingHtml(listingId, { schedule, request: async (url, options) => {
    calls++;
    assert.equal(url.href, `https://www.facebook.com/marketplace/item/${listingId}/`);
    assert.equal(options.method ?? 'GET', 'GET');
    const headers = new Headers(options.headers);
    assert.equal(headers.has('cookie'), false);
    assert.equal(headers.has('authorization'), false);
    assert.equal(options.redirect, 'manual');
    return new Response(page({ recommendations: [{ ...target, id: '999', marketplace_listing_title: 'Golf balls' }], target }));
  } });
  assert.equal(calls, 1);
  assert.equal(result.success, true);
  assert.equal(result.matchingTargetObjects, 1);
  assert.equal(result.fields.descriptionCharacters, target.redacted_description.text.length);
  assert.equal(result.graphqlPosts, 0);
  assert.equal(result.cookiesUsed, false);
  assert.equal(JSON.stringify(result).includes('Salvage'), false);
});

test('HTML diagnostic rejects missing targets and login pages', async () => {
  for (const html of [page({ ...target, id: '999' }), `<form id="login_form"></form>${page(target)}`]) {
    const result = await inspectListingHtml(listingId, { schedule, request: async () => new Response(html) });
    assert.equal(result.success, false);
  }
});

test('HTML diagnostic validates IDs before requests', async () => {
  for (const value of [null, 123, '', 'https://example.com', '../', '1'.repeat(31)]) {
    await assert.rejects(inspectListingHtml(value), error => error.status === 400);
  }
});

test('HTML diagnostic follows allowed redirects without replaying Set-Cookie', async () => {
  let calls = 0;
  const result = await inspectListingHtml(listingId, { schedule, request: async (url, options) => {
    assert.equal(new Headers(options.headers).has('cookie'), false);
    calls++;
    return calls === 1 ? new Response(null, { status: 302, headers: { location: `https://web.facebook.com/marketplace/item/${listingId}/`, 'set-cookie': 'test=secret' } }) : new Response(page(target));
  } });
  assert.equal(calls, 2);
  assert.equal(result.success, true);
});

test('HTML diagnostic rejects external redirects and oversized bodies', async () => {
  let calls = 0;
  await assert.rejects(inspectListingHtml(listingId, { schedule, request: async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'https://example.com' } });
  } }), /allowed hosts/);
  assert.equal(calls, 1);
  await assert.rejects(inspectListingHtml(listingId, { schedule, request: async () => new Response('x'.repeat(5_000_001)) }), /size limit/);
});

test('HTML diagnostic honors cooldown without making a request', async () => {
  await assert.rejects(inspectListingHtml(listingId, { schedule: async () => { throw new Error('cooldown'); },
    request: async () => { assert.fail('Cooldown must block HTTP'); } }), /cooldown/);
});
