import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]
]) blocked.addSubnet(address, prefix);

export function validateProxyServer(proxyServer) {
  let proxy;
  try { proxy = new URL(proxyServer); } catch {}
  if (!/^http:\/\/[0-9.]+:[0-9]+\/?$/.test(proxyServer ?? '') ||
      !proxy || proxy.protocol !== 'http:' || isIP(proxy.hostname) !== 4 ||
      blocked.check(proxy.hostname) || proxy.username || proxy.password ||
      proxy.pathname !== '/' || proxy.search || proxy.hash) {
    throw Object.assign(new Error('Provide an HTTP proxy with a public IPv4 address and port, without credentials.'), { status: 400 });
  }
  return proxy.origin;
}

export async function inspectProxyConnectivity(proxyServer, { createContext } = {}) {
  const server = validateProxyServer(proxyServer);
  const started = performance.now();
  const report = { executionSource: 'server HTTP client', target: 'https://example.com/',
    proxyServer: server, configuredCookiesInjected: false, credentialsSent: false,
    tlsVerification: true, success: false };
  let context;
  try {
    if (!createContext) {
      const { request } = await import('playwright-core');
      createContext = options => request.newContext(options);
    }
    context = await createContext({ proxy: { server }, timeout: 10_000,
      ignoreHTTPSErrors: false });
    const response = await context.get(report.target, { maxRedirects: 0 });
    report.httpStatus = response.status();
    report.expectedPage = (await response.text()).includes('<title>Example Domain</title>');
    report.success = report.httpStatus === 200 && report.expectedPage;
  } catch (error) {
    const message = String(error?.message ?? '');
    report.failure = /timeout|timed out/i.test(message) ? 'timeout' :
      /certificate|SSL|TLS/i.test(message) ? 'tls_failure' : 'connection_failure';
  } finally {
    if (context) {
      try { await context.dispose(); } catch {
        report.failure = 'cleanup_failure';
        report.success = false;
      }
    }
    report.seconds = Number(((performance.now() - started) / 1000).toFixed(3));
  }
  return report;
}
