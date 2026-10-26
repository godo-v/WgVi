// Serves the app folder on http://localhost:5173 so it can run in Chrome or
// Edge (Web Bluetooth needs a secure context, and localhost counts as one).
// Usage: npm run web

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const port = Number(process.env.PORT) || 5173;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

http
  .createServer(async (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`WagVitals running at http://localhost:${port}  (open in Chrome or Edge)`);
  });
