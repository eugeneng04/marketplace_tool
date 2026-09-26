import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number.parseInt(process.env.WEB_PORT ?? "5173", 10);
const host = process.env.WEB_HOST ?? "127.0.0.1";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function resolveRequestPath(url) {
  const { pathname } = new URL(url, "http://localhost");
  const requested = pathname === "/" ? "/index.html" : pathname;
  const resolved = normalize(join(root, requested));
  if (!resolved.startsWith(root)) {
    return null;
  }
  return resolved;
}

const server = createServer(async (req, res) => {
  const filePath = resolveRequestPath(req.url ?? "/");
  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(body);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Server error");
  }
});

server.listen(port, host, () => {
  console.log(`resale-intelligence-web listening on http://${host}:${port}`);
});
