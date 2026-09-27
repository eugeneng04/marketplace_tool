export const FACEBOOK_COOLDOWN_MS = 60 * 60 * 1000;

function cooldownError(until) {
  const error = new Error(`Facebook rate limit reached. Facebook requests are paused until ${new Date(until).toISOString()}. Existing listings remain available; Facebook may require more time before accepting requests.`);
  error.code = 'FACEBOOK_COOLDOWN';
  error.retryAt = until;
  return error;
}

async function isRateLimited(response) {
  if (response?.status === 429) return true;
  if (!response?.ok || typeof response.clone !== 'function') return false;
  // Facebook GraphQL commonly returns rate limits with HTTP 200.
  if (!response.headers.get('content-type')?.includes('json')) {
    // GraphQL responses can use text/plain; HTML token pages are not JSON.
    if (response.headers.get('content-type')?.includes('text/html')) return false;
  }
  try {
    const text = await response.clone().text();
    const data = JSON.parse(text.slice(text.indexOf('{')));
    const errors = Array.isArray(data.errors) ? data.errors : [typeof data.error === 'object' ? data.error : {code:data.error,message:data.errorDescription || data.errorSummary}];
    return errors.some(error => String(error?.code ?? error?.extensions?.code) === '1675004' || /rate limit|too many requests/i.test(error?.message ?? ''));
  } catch { return false; }
}

// All clients in this worker share spacing and a persistent rate-limit cooldown.
export function createFacebookRequestLimiter({ now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), store } = {}) {
  let queue = Promise.resolve();
  let nextRequestAt = 0;
  let blockedUntil = 0;
  async function checkCooldown() {
    if (store) blockedUntil = Math.max(blockedUntil, Number(await store.read()) || 0);
    if (blockedUntil > now()) throw cooldownError(blockedUntil);
  }
  function schedule(request, requestsPerMinute = 20) {
    const rate = Number(requestsPerMinute);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('FB_MAX_REQUESTS_PER_MINUTE must be a positive number.');
    const result = queue.then(async () => {
      await checkCooldown();
      const wait = nextRequestAt - now();
      if (wait > 0) { await sleep(wait); await checkCooldown(); }
      nextRequestAt = now() + Math.ceil(60000 / rate);
      const response = await request();
      // Inspect before releasing the queue, so no queued request slips through.
      if (await isRateLimited(response)) {
        const retryAfter = response.headers?.get('retry-after');
        const seconds = retryAfter == null ? NaN : Number(retryAfter);
        const retryDate = Number.isFinite(seconds) ? now() + seconds * 1000 : Date.parse(retryAfter);
        const hasRetryTime = Number.isFinite(retryDate) && retryDate > now();
        const until = hasRetryTime ? retryDate : now() + FACEBOOK_COOLDOWN_MS;
        blockedUntil = Math.max(blockedUntil, until);
        if (store) await store.write(blockedUntil);
        throw cooldownError(blockedUntil);
      }
      return response;
    });
    queue = result.catch(() => {});
    return result;
  }
  schedule.setStore = value => { store = value; };
  schedule.status = async () => {
    if (store) blockedUntil = Math.max(blockedUntil, Number(await store.read()) || 0);
    return { paused: blockedUntil > now(), retryAt: blockedUntil > now() ? new Date(blockedUntil).toISOString() : null };
  };
  return schedule;
}

export const scheduleFacebookRequest = createFacebookRequestLimiter();

export async function configureFacebookCooldown(db) {
  const store = {
    async read() {
      const result = await db.pool.query("SELECT value_json FROM app_settings WHERE key = 'facebook_cooldown'");
      return Number(result.rows[0]?.value_json?.until) || 0;
    },
    async write(until) {
      await db.pool.query(`INSERT INTO app_settings(key,value_json,updated_at)
        VALUES ('facebook_cooldown',jsonb_build_object('until',$1::bigint),NOW())
        ON CONFLICT(key) DO UPDATE SET value_json=jsonb_build_object('until',GREATEST(
          COALESCE((app_settings.value_json->>'until')::bigint,0),$1::bigint)),updated_at=NOW()`, [until]);
    }
  };
  // Recover recent rejections from the previous release before accepting work.
  const recent = await db.pool.query(`SELECT MAX(finished_at) AS last_limited_at FROM search_runs
    WHERE finished_at > NOW() - INTERVAL '1 hour'
    AND (error_message LIKE '%1675004%' OR error_message ILIKE '%rate limit exceeded%' OR error_message LIKE '%HTTP 429%')`);
  if (recent.rows[0]?.last_limited_at) await store.write(new Date(recent.rows[0].last_limited_at).getTime() + FACEBOOK_COOLDOWN_MS);
  scheduleFacebookRequest.setStore(store);
}
