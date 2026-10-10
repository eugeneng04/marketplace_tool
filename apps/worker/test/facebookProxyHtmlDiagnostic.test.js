import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectProxyListingHtml } from '../src/facebookProxyHtmlDiagnostic.js';

const listingId = '1368882882971991';
const proxy = 'http://176.111.37.5:39811';
const target = { id: listingId, marketplace_listing_title: 'BMW', redacted_description: { text: 'Saved description' }, listing_price: { amount: '18000' } };
const html = Buffer.from(`<script type="application/json">${JSON.stringify(target)}</script>`);
const schedule = operation => operation();

test('proxied listing diagnostic uses fresh contexts for redirects without forwarding cookies or auth', async () => {
  let contexts = 0;
  let disposed = 0;
  const report = await inspectProxyListingHtml(listingId, proxy, { schedule,
    createContext: async options => {
      const hop = ++contexts;
      assert.deepEqual(options, { proxy: { server: proxy }, timeout: 30_000, ignoreHTTPSErrors: false });
      return {
        get: async (url, options) => {
          assert.equal(url, `https://www.facebook.com/marketplace/item/${listingId}/`);
          assert.equal(options.maxRedirects, 0);
          assert.equal(options.maxRetries, 0);
          assert.equal(new Headers(options.headers).has('cookie'), false);
          assert.equal(new Headers(options.headers).has('authorization'), false);
          return { status: () => hop === 1 ? 302 : 200,
            headers: () => hop === 1 ? { location: url, 'set-cookie': 'secret=value' } : {},
            body: async () => html };
        },
        dispose: async () => { disposed++; }
      };
    }
  });
  assert.equal(contexts, 2);
  assert.equal(disposed, 2);
  assert.equal(report.success, true);
  assert.equal(report.fields.descriptionCharacters, target.redacted_description.text.length);
  assert.equal(report.cookiesUsed, false);
  assert.equal(report.graphqlPosts, 0);
  assert.equal(report.requests.length, 2);
  assert.equal(JSON.stringify(report).includes('secret'), false);
});

test('proxied listing diagnostic rejects input and respects cooldown before making requests', async () => {
  const createContext = () => assert.fail('Must not contact proxy');
  await assert.rejects(inspectProxyListingHtml('../', proxy, { createContext }), error => error.status === 400);
  await assert.rejects(inspectProxyListingHtml(listingId, 'http://127.0.0.1:8080', { createContext }), error => error.status === 400);
  await assert.rejects(inspectProxyListingHtml(listingId, proxy, { createContext,
    schedule: () => { throw Object.assign(new Error('Paused'), { code: 'FACEBOOK_COOLDOWN' }); }
  }), error => error.code === 'FACEBOOK_COOLDOWN');
});

test('proxied listing diagnostic sanitizes connection and cleanup failures', async () => {
  for (const cleanupFails of [false, true]) {
    let disposed = false;
    const report = await inspectProxyListingHtml(listingId, proxy, { schedule,
      createContext: async () => ({
        get: async () => { throw new Error('Private upstream data'); },
        dispose: async () => { disposed = true; if (cleanupFails) throw new Error('Private cleanup'); }
      })
    });
    assert.equal(disposed, true);
    assert.equal(report.success, false);
    assert.equal(report.failure, 'proxy_request_failed');
    assert.equal(JSON.stringify(report).includes('Private'), false);
  }
});
