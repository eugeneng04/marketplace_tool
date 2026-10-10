import { inspectListingHtml } from './facebookListingHtmlDiagnostic.js';
import { validateProxyServer } from './proxyConnectivityDiagnostic.js';

export async function inspectProxyListingHtml(listingId, proxyServer, { createContext, schedule, requestsPerMinute = 3 } = {}) {
  const server = validateProxyServer(proxyServer);
  const started = performance.now();
  try {
    const report = await inspectListingHtml(listingId, { schedule, requestsPerMinute,
      request: async (url, options) => {
        if (!createContext) {
          const { request } = await import('playwright-core');
          createContext = options => request.newContext(options);
        }
        options.signal.throwIfAborted();
        // A new context for each redirect prevents replay of Facebook's Set-Cookie headers.
        const context = await createContext({ proxy: { server }, timeout: 30_000,
          ignoreHTTPSErrors: false });
        try {
          const response = await context.get(url.href, { headers: options.headers,
            maxRedirects: 0, maxRetries: 0 });
          const status = response.status();
          const headers = response.headers();
          const body = status >= 300 && status < 400 || [204, 205].includes(status) ? null : await response.body();
          if (body?.length > 5_000_000) throw new Error('Listing HTML exceeded the diagnostic size limit.');
          return new Response(body, { status, headers: Object.fromEntries(
            ['content-type', 'location', 'retry-after'].filter(name => headers[name]).map(name => [name, headers[name]])
          ) });
        } finally {
          await context.dispose();
        }
      }
    });
    return { ...report, executionSource: 'server proxied HTML', proxyServer: server, tlsVerification: true };
  } catch (error) {
    if (error.status === 400 || error.code === 'FACEBOOK_COOLDOWN') throw error;
    return { executionSource: 'server proxied HTML', listingId, proxyServer: server,
      cookiesUsed: false, cookieJarUsed: false, graphqlPosts: 0, tlsVerification: true,
      success: false, failure: 'proxy_request_failed', seconds: Number(((performance.now() - started) / 1000).toFixed(3)) };
  }
}
