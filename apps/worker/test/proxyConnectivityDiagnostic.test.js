import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectProxyConnectivity } from '../src/proxyConnectivityDiagnostic.js';

test('proxy check uses a fixed HTTPS target without credentials and verifies the page', async () => {
  let disposed = false;
  const result = await inspectProxyConnectivity('http://176.111.37.5:39811', {
    createContext: async options => {
      assert.deepEqual(options, { proxy: { server: 'http://176.111.37.5:39811' },
        timeout: 10_000, ignoreHTTPSErrors: false });
      return {
        get: async (url, options) => {
          assert.equal(url, 'https://example.com/');
          assert.deepEqual(options, { maxRedirects: 0 });
          return { status: () => 200, text: async () => '<title>Example Domain</title>' };
        },
        dispose: async () => { disposed = true; }
      };
    }
  });
  assert.equal(result.success, true);
  assert.equal(disposed, true);
});

test('proxy check rejects internal addresses, hostnames, credentials and other protocols before networking', async () => {
  for (const proxy of [undefined, 'bad', 'http://localhost:80', 'http://127.0.0.1:8080',
    'http://10.0.0.1:8080', 'http://169.254.169.254:8080', 'http://192.168.1.1:8080',
    'http://100.64.0.1:8080', 'http://[::1]:8080', 'http://2130706433:8080',
    'http://user:secret@176.111.37.5:39811', 'socks5://176.111.37.5:39811',
    'http://176.111.37.5:39811/other', 'http://176.111.37.5:39811?token=secret']) {
    await assert.rejects(inspectProxyConnectivity(proxy, {
      createContext: () => assert.fail('Invalid input reached networking')
    }), error => error.status === 400);
  }
});

test('proxy check accepts port 80 and sanitizes disposal failures', async () => {
  const report = await inspectProxyConnectivity('http://176.111.37.5:80', {
    createContext: async options => {
      assert.equal(options.proxy.server, 'http://176.111.37.5');
      return { get: async () => ({ status: () => 200,
        text: async () => '<title>Example Domain</title>' }),
        dispose: async () => { throw new Error('Private cleanup error'); } };
    }
  });
  assert.equal(report.success, false);
  assert.equal(report.failure, 'cleanup_failure');
  assert.equal(JSON.stringify(report).includes('Private'), false);
});

test('proxy check distinguishes unexpected pages and sanitized connection errors', async () => {
  const wrongPage = await inspectProxyConnectivity('http://176.111.37.5:39811', {
    createContext: async () => ({ get: async () => ({ status: () => 200,
      text: async () => 'Private response' }), dispose: async () => {} })
  });
  assert.equal(wrongPage.success, false);
  assert.equal(JSON.stringify(wrongPage).includes('Private response'), false);
  for (const [message, failure] of [['Timeout 10000ms secret', 'timeout'],
    ['SSL certificate secret', 'tls_failure'], ['ECONNREFUSED secret', 'connection_failure']]) {
    let disposed = false;
    const report = await inspectProxyConnectivity('http://176.111.37.5:39811', {
      createContext: async () => ({ get: async () => { throw new Error(message); },
        dispose: async () => { disposed = true; } })
    });
    assert.equal(report.failure, failure);
    assert.equal(report.success, false);
    assert.equal(JSON.stringify(report).includes('secret'), false);
    assert.equal(disposed, true);
  }
});
