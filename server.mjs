import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.resolve(__dirname, 'dist');
const port = parseInt(process.env.PORT || '5173', 10);
const host = '0.0.0.0';

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  // Only accept GET and HEAD
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.end('Method Not Allowed');
    return;
  }

  // Parse path and prevent path traversal
  const rawPath = (req.url || '/').split('?')[0];
  const safePath = path.normalize(rawPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(distDir, safePath);

  try {
    const stats = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
    if (stats && stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');

      // Asset cache policy
      if (rawPath.startsWith('/assets/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      }

      if (req.method === 'HEAD') {
        res.statusCode = 200;
        res.end();
        return;
      }

      fs.createReadStream(filePath).pipe(res);
      return;
    }
  } catch (err) {
    console.error('File read error:', err);
  }

  // SPA fallback: return index.html for all non-asset routes
  const indexPath = path.join(distDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    if (req.method === 'HEAD') {
      res.statusCode = 200;
      res.end();
      return;
    }
    fs.createReadStream(indexPath).pipe(res);
  } else {
    res.statusCode = 404;
    res.end('dist/index.html not found. Please run npm run build first.');
  }
});

server.listen(port, host, () => {
  console.log(`DocuTalk AI production server running at http://${host}:${port}/`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
