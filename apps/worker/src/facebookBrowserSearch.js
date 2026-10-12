import {browserCookies, facebookPageCategory, summarizeGraphql} from './facebookBrowserDiagnostic.js';
import {parseMarketplaceSearchHtml} from './facebookGraphqlClient.js';
import {scheduleFacebookRequest} from './facebookRequestLimiter.js';

export async function searchMarketplaceBrowser(params, {cookieHeader, requestsPerMinute=3,
  schedule=scheduleFacebookRequest, launch, onCookieHeader} = {}) {
  const url = new URL(params.searchUrl || 'https://www.facebook.com/marketplace/search/');
  if (url.protocol !== 'https:' || !/(^|\.)facebook\.com$/i.test(url.hostname) || !url.pathname.startsWith('/marketplace/') || url.username || url.password) {
    throw new Error('Search URLs must point to a Facebook Marketplace page.');
  }
  url.searchParams.set('query',params.query);
  for (const key of ['minPrice','maxPrice','latitude','longitude']) {
    if (params[key] !== undefined) url.searchParams.set(key,`${params[key]}`);
  }
  if (params.radiusKm !== undefined) url.searchParams.set('radius',`${Math.round(params.radiusKm / 1.60934)}`);
  url.searchParams.set('sortBy','creation_time_descend');
  url.searchParams.set('daysSinceListed',`${params.newestWithinDays ?? 1}`);
  if (params.category) url.searchParams.set('category_id',params.category);
  const status = await schedule.status();
  if (status.paused) {
    const error = new Error(`Facebook requests are paused until ${status.retryAt}.`);
    error.code='FACEBOOK_COOLDOWN';error.retryAt=Date.parse(status.retryAt);throw error;
  }
  let browser;
  let stopped=false;
  let accepting=true;
  const inFlight=new Set();
  let upstreamFailure;
  let graphqlRequests=0;
  let documentRequests=0;
  const requests=[];
  let timer;
  try {
    if (launch) browser=await launch();
    else {
      const {chromium}=await import('playwright-core');
      browser=await chromium.launch({channel:'chromium',headless:true,timeout:30000});
    }
    timer=setTimeout(()=>{stopped=true;void browser.close().catch(()=>{});},110000);
    const context=await browser.newContext({viewport:{width:1280,height:900},locale:'en-US',serviceWorkers:'block'});
    if (cookieHeader) await context.addCookies(browserCookies(cookieHeader));
    const page=await context.newPage();
    const handleRoute=async route=>{
      const request=route.request();
      const target=new URL(request.url());
      const facebook=/(^|\.)facebook\.com$/i.test(target.hostname);
      const cdn=/(^|\.)fbcdn\.net$/i.test(target.hostname);
      if (stopped || !accepting || (!facebook && !cdn) || ['image','media','font'].includes(request.resourceType())) return route.abort().catch(()=>{});
      const graphql=facebook && target.pathname==='/api/graphql/';
      const document=request.resourceType()==='document';
      if (!graphql && !document) return route.continue().catch(()=>{});
      if ((graphql && ++graphqlRequests>4) || (document && ++documentRequests>3)) return route.abort().catch(()=>{});
      let continued=false;
      try {
        await schedule(async()=>{
          if (stopped) throw new Error('Search stopped');
          const pending=page.waitForResponse(response=>response.request()===request,{timeout:30000});
          pending.catch(()=>{});
          continued=true;await route.continue();
          const response=await pending;
          const text=graphql ? await response.text() : '';
          const summary=graphql ? summarizeGraphql(text) : {};
          requests.push({kind:graphql?'graphql':'document',httpStatus:response.status(),...summary});
          return new Response([204,205,304].includes(response.status()) ? null : text,
            {status:response.status(),headers:{'retry-after':response.headers()['retry-after'] ?? ''}});
        },requestsPerMinute);
      } catch(error) {
        upstreamFailure=error;stopped=true;
        if (!continued) await route.abort().catch(()=>{});
      }
    };
    await context.route('**/*',route=>{
      const pending=handleRoute(route);
      inFlight.add(pending);
      pending.finally(()=>inFlight.delete(pending)).catch(()=>{});
      return pending;
    });
    await page.goto(url.href,{waitUntil:'commit',timeout:70000});
    const deadline=Date.now()+60000;
    while (!stopped && Date.now()<deadline) {
      const category=facebookPageCategory(new URL(page.url()).pathname);
      if (['login_required','security_checkpoint'].includes(category)) throw new Error('Facebook rejected the browser session. Sign in and retry.');
      const visibleIds=await page.locator('a[href*="/marketplace/item/"]:visible').evaluateAll(elements=>elements.map(element=>element.getAttribute('href')?.match(/\/marketplace\/item\/(\d+)/)?.[1]).filter(Boolean));
      if (visibleIds.length) {
        const html=await page.content();
        const viewerId=html.match(/"USER_ID"\s*:\s*"(\d+)"/)?.[1];
        if (cookieHeader && (!viewerId || viewerId==='0')) throw new Error('Facebook browser session could not be verified as signed in.');
        const ids=new Set(visibleIds);
        const listings=parseMarketplaceSearchHtml(html,params.limit,ids);
        if (listings.length) {
          accepting=false;
          await Promise.allSettled([...inFlight]);
          if (upstreamFailure) throw upstreamFailure;
          if (onCookieHeader) onCookieHeader((await context.cookies('https://www.facebook.com/')).map(cookie=>`${cookie.name}=${cookie.value}`).join('; '));
          return {listings,hasNextPage:false,endCursor:null,diagnostics:{cardSource:'marketplace_browser',pageViewer:viewerId && viewerId!=='0'?'signed_in':'unknown',
            pageCardCount:listings.length,requests,paginationAvailable:false,requestedFiltersVerified:false}};
        }
      }
      await page.waitForTimeout(500);
    }
    if (upstreamFailure) throw upstreamFailure;
    throw new Error('No verifiable Marketplace search cards appeared before the browser deadline.');
  } catch(error) {
    if (error.code==='FACEBOOK_COOLDOWN' || /session|verifiable/.test(error.message)) throw error;
    throw new Error('Marketplace browser search failed before verified cards were available.');
  } finally {
    stopped=true;clearTimeout(timer);
    await browser?.close().catch(()=>{});
  }
}
