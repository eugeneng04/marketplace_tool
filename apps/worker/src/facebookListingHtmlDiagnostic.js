import { scheduleFacebookRequest } from './facebookRequestLimiter.js';
import { parseListingDetailResponse } from './facebookGraphqlClient.js';

export async function inspectListingHtml(listingId, { request = fetch, schedule = scheduleFacebookRequest, requestsPerMinute = 3 } = {}) {
  if (typeof listingId !== 'string' || !/^\d{1,30}$/.test(listingId)) {
    const error = new Error('listingId must be a numeric Marketplace ID.');
    error.status = 400;
    throw error;
  }
  const headers = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none',
    'upgrade-insecure-requests': '1'
  };
  const started = performance.now();
  let url = new URL(`https://www.facebook.com/marketplace/item/${listingId}/`);
  const requests = [];
  let response;
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== 'https:' || !['www.facebook.com', 'web.facebook.com'].includes(url.hostname) || url.username || url.password) {
      throw new Error('Facebook redirected outside the allowed hosts.');
    }
    response = await schedule(() => request(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(30000) }), requestsPerMinute);
    requests.push({ method: 'GET', status: response.status, cookieHeaderSent: false });
    if (response.status < 300 || response.status >= 400 || !response.headers.get('location')) break;
    await response.body?.cancel();
    url = new URL(response.headers.get('location'), url);
  }
  const chunks = [];
  let htmlBytes = 0;
  for await (const chunk of response.body) {
    htmlBytes += chunk.length;
    if (htmlBytes > 5_000_000) throw new Error('Listing HTML exceeded the diagnostic size limit.');
    chunks.push(chunk);
  }
  const html = Buffer.concat(chunks).toString('utf8');
  const fetchSeconds = (performance.now() - started) / 1000;
  const parseStarted = performance.now();
  const loginPage = /\/(?:login|checkpoint)(?:\/|$)/i.test(url.pathname) || /id=["']login_form["']/i.test(html);
  const targets = [];
  for (const block of html.matchAll(/<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let value;
    try { value = JSON.parse(block[1]); } catch { continue; }
    const pending = [value];
    while (pending.length) {
      const node = pending.pop();
      if (!node || typeof node !== 'object') continue;
      if (node.id === listingId && typeof node.marketplace_listing_title === 'string' &&
          typeof node.redacted_description?.text === 'string') targets.push(node);
      for (const child of Object.values(node)) pending.push(child);
    }
  }
  const target = targets[0];
  const detail = target ? parseListingDetailResponse({ data: { viewer: { marketplace_product_details_page: { target } } } }, listingId) : null;
  return {
    executionSource: 'server direct HTML', listingId, cookiesUsed: false, cookieJarUsed: false, graphqlPosts: 0,
    requests, htmlBytes, fetchSeconds: Number(fetchSeconds.toFixed(3)),
    parseSeconds: Number(((performance.now() - parseStarted) / 1000).toFixed(4)), loginPage,
    matchingTargetObjects: targets.length,
    success: response.ok && !loginPage && Boolean(detail),
    fields: detail ? { titlePresent: Boolean(detail.title), pricePresent: Boolean(detail.price),
      descriptionCharacters: detail.description.length, mileagePresent: Number.isFinite(detail.mileage),
      transmissionPresent: Boolean(detail.vehicleAttributes.transmission), locationPresent: Boolean(detail.location),
      photosInDetail: detail.images.length } : null
  };
}
