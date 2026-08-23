// Minimal static file server for local development. No dependencies.
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.md': 'text/markdown; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
  req.setTimeout(10000, () => req.destroy());
  res.setTimeout(10000, () => res.destroy());
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/dev-store') {
      if (req.method === 'POST') {
        const chunks = [];
        req.on('error', () => res.destroy());
        for await (const c of req) chunks.push(c);
        await mkdir(path.join(ROOT, '.tmp'), { recursive: true });
        await writeFile(path.join(ROOT, '.tmp', 'devstore.bin'), Buffer.concat(chunks));
        if (!res.writableEnded) {
          res.writeHead(200, { 'Cache-Control': 'no-store' });
          res.end('stored');
        }
        return;
      }
      const data = await readFile(path.join(ROOT, '.tmp', 'devstore.bin'));
      if (!res.writableEnded) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(data);
      }
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const abs = path.join(ROOT, rel);
    if (!path.resolve(abs).startsWith(path.resolve(ROOT))) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    const data = await readFile(abs);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});

server.listen(PORT, () => console.log(`gridpulse dev server: http://localhost:${PORT}`));
