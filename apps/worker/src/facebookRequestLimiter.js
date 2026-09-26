// Shared by all clients in this worker, including search and location clients.
export function createFacebookRequestLimiter({ now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let queue = Promise.resolve();
  let nextRequestAt = 0;
  return function schedule(request, requestsPerMinute = 3) {
    const rate = Number(requestsPerMinute);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('FB_MAX_REQUESTS_PER_MINUTE must be a positive number.');
    const result = queue.then(async () => {
      const wait = nextRequestAt - now();
      if (wait > 0) await sleep(wait);
      nextRequestAt = now() + Math.ceil(60000 / rate);
      const response = await request();
      if (response?.status === 429) {
        const retryAfter = response.headers?.get("retry-after");
        const seconds = retryAfter === null || retryAfter === undefined ? NaN : Number(retryAfter);
        const until = Number.isFinite(seconds) ? now() + seconds * 1000 : Date.parse(retryAfter);
        nextRequestAt = Math.max(nextRequestAt, now() + 60000, Number.isFinite(until) ? until : 0);
      }
      return response;
    });
    // Serialize requests through completion; failures must not poison the queue.
    queue = result.catch(() => {});
    return result;
  };
}

export const scheduleFacebookRequest = createFacebookRequestLimiter();
