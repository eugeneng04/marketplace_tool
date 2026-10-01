// Describe returned search fields without exporting session credentials.
export function inspectSearchPayload(payload) {
  const fields = new Map();
  function visit(value, path = '', depth = 0) {
    if (depth > 16 || !value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/cookie|token|password|fb_dtsg|^lsd$|^xs$|^c_user$/i.test(key)) continue;
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
