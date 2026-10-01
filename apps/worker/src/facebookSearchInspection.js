const SENSITIVE_KEY = /cookie|token|password|secret|authorization|fb_dtsg|jazoest|csrf|^lsd$|^xs$|^c_user$/i;

// A bounded copy of the actual response, never the request or its credentials.
export function sanitizeFacebookEvidence(value, session = {}) {
  const secrets = [session.cookieHeader, session.fbDtsg, session.lsd,
    ...(session.cookieHeader || '').split(';').map(part => part.slice(part.indexOf('=') + 1).trim())]
    .filter(Boolean).sort((a, b) => b.length - a.length);
  let remaining = 100000;
  function copy(input, depth = 0) {
    if (remaining <= 0 || depth > 16) return '[truncated]';
    if (typeof input === 'string') {
      let safe = input;
      for (const secret of secrets) safe = safe.split(secret).join('[redacted]');
      safe = safe.replace(/(?:fb_dtsg|lsd|access_token|xs|c_user)\s*[=:]\s*[^\s;,]+/gi, '[credential redacted]');
      safe = safe.replace(/https?:\/\/[^\s"<>]+/gi, value => {
        try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return '[URL]'; }
      });
      const bounded = safe.slice(0, Math.min(2000, remaining));
      remaining -= bounded.length;
      return bounded;
    }
    if (!input || typeof input !== 'object') return input;
    if (Array.isArray(input)) return input.slice(0, 50).map(child => copy(child, depth + 1));
    const result = {};
    for (const [key, child] of Object.entries(input).slice(0, 100)) {
      if (SENSITIVE_KEY.test(key)) continue;
      remaining -= key.length + 8;
      if (remaining <= 0) break;
      result[key] = copy(child, depth + 1);
    }
    return result;
  }
  return copy(value);
}

// Describe returned search fields without exporting session credentials.
export function inspectSearchPayload(payload) {
  const fields = new Map();
  function visit(value, path = '', depth = 0) {
    if (depth > 16 || !value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) continue;
      const name = path ? `${path}.${key}` : key;
      const type = child === null ? 'null' : Array.isArray(child) ? 'array' : typeof child;
      const field = fields.get(name) ?? {path:name, types:[], occurrences:0, nonNull:0, example:null};
      if (!field.types.includes(type)) field.types.push(type);
      field.occurrences += 1;
      if (child !== null && child !== undefined) field.nonNull += 1;
      if (field.example === null && ['string','number','boolean'].includes(type)) {
        let example = child;
        if (typeof example === 'string') {
          example = example.slice(0, 300);
          if (/^https?:\/\//.test(example)) {
            try { const url = new URL(example); example = `${url.origin}${url.pathname}`; } catch { example = '[URL]'; }
          }
        }
        field.example = example;
      }
      fields.set(name, field);
      if (Array.isArray(child)) for (const entry of child) visit(entry, `${name}[]`, depth+1);
      else visit(child, name, depth+1);
    }
  }
  visit(payload);
  return [...fields.values()].sort((a,b)=>a.path.localeCompare(b.path));
}
