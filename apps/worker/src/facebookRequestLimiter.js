// Facebook often omits Retry-After from GraphQL throttling errors. A missing
// header must not turn one rejection into an hour-long application outage.
export const FACEBOOK_COOLDOWN_MS = 5 * 60 * 1000;

function cooldownError(until) {
  const error = new Error(`Facebook rate limit reached. Facebook requests are paused until ${new Date(until).toISOString()}. Existing listings remain available; retry after the stated time.`);
  error.code = 'FACEBOOK_COOLDOWN';
  error.retryAt = until;
  return error;
}

async function isRateLimited(response) {
  if (response?.status === 429) return true;
  if (!response?.ok || typeof response.clone !== 'function') return false;
  // Facebook can return GraphQL JSON with HTTP 200 and a text/html header.
  // Inspect the body prefix instead of trusting the declared content type.
  try {
    const text = await response.clone().text();
    const json = text.trimStart().replace(/^for\s*\(;;\);\s*/, '');
    if (!json.startsWith('{')) return false;
    const data = JSON.parse(json);
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
        if (store) await store.write(blockedUntil, { retryAfter: hasRetryTime });
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
    async write(until, { retryAfter = false } = {}) {
      await db.pool.query(`INSERT INTO app_settings(key,value_json,updated_at)
        VALUES ('facebook_cooldown',jsonb_build_object('until',$1::bigint,'retryAfter',$2::boolean),NOW())
        ON CONFLICT(key) DO UPDATE SET value_json=jsonb_build_object('until',GREATEST(
          COALESCE((app_settings.value_json->>'until')::bigint,0),$1::bigint),
          'retryAfter',$2::boolean),updated_at=NOW()`, [until, retryAfter]);
    }
  };
  // Previous releases stored the application's one-hour fallback exactly like
  // a server-provided Retry-After. Bound those legacy lockouts during upgrade.
  await db.pool.query(`UPDATE app_settings SET value_json=jsonb_build_object(
      'until',(extract(epoch from NOW() + INTERVAL '5 minutes') * 1000)::bigint,
      'retryAfter',false), updated_at=NOW()
    WHERE key='facebook_cooldown' AND NOT (value_json ? 'retryAfter')
      AND COALESCE((value_json->>'until')::bigint,0) >
        (extract(epoch from NOW() + INTERVAL '5 minutes') * 1000)::bigint`);
  // Recover recent rejections from the previous release before accepting work.
  const recent = await db.pool.query(`SELECT MAX(finished_at) AS last_limited_at FROM search_runs
    WHERE finished_at > NOW() - INTERVAL '5 minutes'
    AND (error_message LIKE '%1675004%' OR error_message ILIKE '%rate limit exceeded%' OR error_message LIKE '%HTTP 429%')`);
  if (recent.rows[0]?.last_limited_at) await store.write(new Date(recent.rows[0].last_limited_at).getTime() + FACEBOOK_COOLDOWN_MS);
  scheduleFacebookRequest.setStore(store);
}
