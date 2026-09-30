import { scheduleFacebookRequest } from './facebookRequestLimiter.js';
import {createHash} from 'node:crypto';

export function sessionCookieHash(header) {
  const cookies = browserCookies(header);
  return createHash('sha256').update(JSON.stringify(['c_user','xs'].map(name => cookies.find(cookie=>cookie.name===name)?.value ?? ''))).digest('hex');
}

export function facebookPageCategory(path) {
  if (/checkpoint|challenge/i.test(path)) return 'security_checkpoint';
  if (/login/i.test(path)) return 'login_required';
  if (path.startsWith('/marketplace')) return 'marketplace';
  return 'other_facebook_page';
}

export function browserCookies(header) {
  return header.split(';').flatMap(part => {
    const separator = part.indexOf('=');
    const name = part.slice(0, separator).trim();
    if (separator < 1 || !name) return [];
    return [{name, value:part.slice(separator + 1).trim(), domain:'.facebook.com', path:'/', secure:true}];
  });
}

export function summarizeGraphql(text) {
  const codes = new Set();
  let hasData = false;
  let rateLimited = false;
  for (const line of text.trim().replace(/^for\s*\(;;\);\s*/, '').split('\n')) {
    try {
      const data = JSON.parse(line);
      hasData ||= Boolean(data.data);
      const errors = Array.isArray(data.errors) ? data.errors : [{code:data.error, message:data.errorDescription}];
      for (const error of errors) {
        const code = String(error?.code ?? error?.extensions?.code ?? '');
        if (/^\d+$/.test(code)) codes.add(code);
        rateLimited ||= code === '1675004' || /rate limit|too many requests/i.test(error?.message ?? '');
      }
    } catch { /* HTML and incomplete stream fragments are not GraphQL JSON. */ }
  }
  return {errorCodes:[...codes], hasData, rateLimited};
}

export function createBrowserDiagnostic({config, schedule = scheduleFacebookRequest, launch} = {}) {
  let job = null;
  let running = false;
  let nextAllowedAt = 0;
  const status = () => job ?? {state:'idle'};
  async function start({mode='configured', expectedSessionHash} = {}) {
    if (running) return status();
    const cooldown = await schedule.status();
    if (cooldown.paused) return {state:'paused', retryAt:cooldown.retryAt};
    if (Date.now() < nextAllowedAt) return {state:'paused', retryAt:new Date(nextAllowedAt).toISOString()};
    // Recheck after the asynchronous cooldown read to exclude concurrent starts.
    if (running) return status();
    running = true;
    nextAllowedAt = Date.now() + 5 * 60_000;
    job = {state:'running', startedAt:new Date().toISOString(), runtime:process.version,
      cookieConfigured:Boolean(config.facebookCookie), mode, query:'corvette', maxGraphqlRequests:4,
      requests:[], listingCount:0, outcome:null};
    const cookieNames = new Set(browserCookies(config.facebookCookie).map(cookie=>cookie.name));
    job.sessionCookiePresent = {cUser:cookieNames.has('c_user'), xs:cookieNames.has('xs')};
    if (/^[a-f0-9]{64}$/.test(expectedSessionHash ?? '')) job.sessionMatchesLocal = sessionCookieHash(config.facebookCookie) === expectedSessionHash;
    void run().finally(() => {running=false;});
    return status();
  }
  async function run() {
    let browser;
    let stopped = false;
    let graphCount = 0;
    let documentCount = 0;
    let timer;
    try {
      if (launch) browser = await launch();
      else {
        const [{chromium:playwright}, {default:chromium}] = await Promise.all([
          import('playwright-core'), import('@sparticuz/chromium')
        ]);
        browser = await playwright.launch({args:chromium.args, executablePath:await chromium.executablePath(), timeout:30_000});
      }
      job.browserVersion = browser.version();
      const context = await browser.newContext({viewport:{width:1280,height:900}, locale:'en-US', serviceWorkers:'block'});
      if (job.mode === 'configured' && config.facebookCookie) await context.addCookies(browserCookies(config.facebookCookie));
      const page = await context.newPage();
      timer = setTimeout(() => {stopped=true; void browser.close().catch(()=>{});}, 110_000);
      await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const facebook = url.hostname === 'facebook.com' || url.hostname.endsWith('.facebook.com');
        const cdn = url.hostname === 'fbcdn.net' || url.hostname.endsWith('.fbcdn.net');
        if (stopped || (!facebook && !cdn) || ['image','media','font'].includes(request.resourceType())) {
          return route.abort().catch(()=>{});
        }
        const graphql = facebook && url.pathname === '/api/graphql/';
        const document = request.resourceType() === 'document';
        if (!graphql && !document) return route.continue().catch(()=>{});
        if ((graphql && ++graphCount > 4) || (document && ++documentCount > 3)) {
          return route.abort().catch(()=>{});
        }
        try {
          await schedule(async () => {
            if (stopped) throw new Error('Diagnostic stopped');
            const responsePromise = page.waitForResponse(response => response.request() === request, {timeout:30_000});
            // Attach a handler before continuing, including when continuation fails.
            responsePromise.catch(()=>{});
            await route.continue();
            const response = await responsePromise;
            const headers = response.headers();
            const operation = new URLSearchParams(request.postData() ?? '').get('fb_api_req_friendly_name');
            const record = {kind:graphql?'graphql':'document', status:response.status(),
              operation:/^[A-Za-z0-9_]{1,160}$/.test(operation ?? '')?operation:undefined,
              contentType:headers['content-type'] ?? null};
            if (document) record.pageCategory=facebookPageCategory(url.pathname);
            job.requests.push(record);
            // Chromium does not provide redirect bodies; record the status without reading them.
            const text = response.status() >= 300 && response.status() < 400 ? '' : await response.text();
            const summary = graphql ? summarizeGraphql(text) : {};
            Object.assign(record, summary);
            if (summary.rateLimited || response.status() === 429) {
              job.outcome='rate_limited'; stopped=true;
            }
            return new Response(text,{status:response.status(),headers});
          }, Math.min(3, config.facebookMaxRequestsPerMinute));
        } catch (error) {
          if (error.code === 'FACEBOOK_COOLDOWN') {job.outcome='rate_limited'; stopped=true;}
          else if (!stopped) job.requestFailure=true;
          await route.abort().catch(()=>{});
        }
      });
      await page.goto('https://www.facebook.com/marketplace/search/?query=corvette', {waitUntil:'domcontentloaded', timeout:70_000});
      const deadline = Date.now() + 60_000;
      while (!stopped && Date.now() < deadline) {
        const path = new URL(page.url()).pathname;
        job.finalPageCategory=facebookPageCategory(path);
        if (['login_required','security_checkpoint'].includes(job.finalPageCategory)) {job.outcome=job.finalPageCategory; break;}
        const links = await page.locator('a[href*="/marketplace/item/"]:visible').evaluateAll(elements => elements.map(element => element.getAttribute('href')));
        job.listingCount = new Set(links.map(href => href.match(/\/marketplace\/item\/(\d+)/)?.[1]).filter(Boolean)).size;
        if (job.listingCount > 0) {job.outcome='listings_visible'; break;}
        await page.waitForTimeout(1000);
      }
      job.outcome ??= 'no_listings_observed';
    } catch (error) {
      // Browser errors can contain navigation URLs or credentials: return categories only.
      job.outcome ??= browser ? 'navigation_failed' : 'browser_launch_failed';
      job.errorType = error.name;
    } finally {
      stopped=true;
      clearTimeout(timer);
      if (browser) await browser.close().catch(()=>{});
      job.state='finished';
      job.finishedAt=new Date().toISOString();
    }
  }
  return {start,status};
}
