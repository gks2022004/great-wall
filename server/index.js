import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Telegram } from './telegram.js';
import { Storage } from './storage.js';
import { Wall, httpError } from './wall.js';
import { preview, readLimited } from './preview.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const PORT = Number(env.PORT) || 3000;
const DATA_DIR = path.resolve(root, env.DATA_DIR || 'data');
const MAX_UPLOAD = (Number(env.MAX_UPLOAD_MB) || 200) * 1024 * 1024;
const PASSWORD = env.ADMIN_PASSWORD || '';
const SECRET = env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// ---- storage ----------------------------------------------------------------

let telegram = null;
if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
  telegram = new Telegram(env.TELEGRAM_BOT_TOKEN.trim(), env.TELEGRAM_CHAT_ID.trim(), env.TELEGRAM_API_URL || undefined);
  try {
    const me = await telegram.me();
    console.log(`[telegram] storing files via @${me.username} in chat ${env.TELEGRAM_CHAT_ID}`);
  } catch (err) {
    console.error(`[telegram] bot token rejected: ${err.message}`);
    process.exit(1);
  }
} else {
  console.log('[storage] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — storing files on local disk');
}

const storage = new Storage({ dataDir: DATA_DIR, telegram, cacheMaxBytes: (Number(env.CACHE_MAX_MB) || 1024) * 1024 * 1024 });
const wall = new Wall({ dataDir: DATA_DIR, telegram });
await wall.init();

if (!PASSWORD) console.warn('[auth] ADMIN_PASSWORD is not set — ANYONE who opens the wall can edit it. Set it before going public.');
if (PASSWORD && !env.SESSION_SECRET) console.warn('[auth] SESSION_SECRET is not set — you will be logged out whenever the server restarts.');

// ---- auth -------------------------------------------------------------------

const COOKIE = 'gw_session';
const token = () => crypto.createHmac('sha256', SECRET).update(`owner|${PASSWORD}`).digest('base64url');

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const canEdit = (req) => !PASSWORD || safeEqual(cookies(req)[COOKIE] || '', token());

function requireEdit(req, res, next) {
  if (canEdit(req)) return next();
  res.status(401).json({ error: 'Log in to edit the wall' });
}

const attempts = new Map();
function loginRateLimit(req, res, next) {
  const now = Date.now();
  const a = attempts.get(req.ip) || { n: 0, t: now };
  if (now - a.t > 15 * 60 * 1000) { a.n = 0; a.t = now; }
  if (a.n >= 10) return res.status(429).json({ error: 'Too many attempts, try again later' });
  a.n++;
  attempts.set(req.ip, a);
  next();
}

// ---- app --------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', env.TRUST_PROXY ?? 'loopback, linklocal, uniquelocal');
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/wall', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: wall.publicItems(), canEdit: canEdit(req), authRequired: !!PASSWORD, backend: storage.backend });
});

app.post('/api/login', loginRateLimit, (req, res) => {
  if (!PASSWORD) return res.json({ ok: true });
  if (!safeEqual(req.body?.password || '', PASSWORD)) return res.status(401).json({ error: 'Wrong password' });
  attempts.delete(req.ip);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 90}${secure}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.post('/api/items', requireEdit, asyncRoute(async (req, res) => {
  res.status(201).json(await wall.addItem(req.body || {}));
}));

app.patch('/api/items/:id', requireEdit, asyncRoute(async (req, res) => {
  const item = await wall.updateItem(req.params.id, req.body || {});
  if (!item) throw httpError(404, 'No such item');
  res.json(item);
}));

app.delete('/api/items/:id', requireEdit, asyncRoute(async (req, res) => {
  const orphans = await wall.removeItem(req.params.id);
  res.json({ ok: true });
  for (const obj of orphans) storage.remove(obj).catch((err) => console.warn(`[storage] cleanup failed: ${err.message}`));
}));

const upload = multer({
  storage: multer.diskStorage({ destination: storage.tmpDir, filename: (_req, _file, cb) => cb(null, path.basename(storage.tmpFile())) }),
  limits: { fileSize: MAX_UPLOAD, files: 1 },
});

async function saveObject(tmpPath, name, mime) {
  try {
    const obj = await storage.put(tmpPath, { name, mime });
    await wall.addObject(obj);
    return { id: obj.id, url: `/f/${obj.id}`, name: obj.name, mime: obj.mime, size: obj.size };
  } finally {
    await fsp.rm(tmpPath, { force: true });
  }
}

app.post('/api/upload', requireEdit, upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) throw httpError(400, 'No file received');
  const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  res.status(201).json(await saveObject(req.file.path, name, req.file.mimetype));
}));

app.post('/api/preview', requireEdit, asyncRoute(async (req, res) => {
  const url = String(req.body?.url || '');
  if (!/^https?:\/\//i.test(url)) throw httpError(400, 'That does not look like a link');
  try {
    const result = await preview(url, {
      maxRemoteBytes: Math.min(MAX_UPLOAD, 50 * 1024 * 1024),
      storeRemote: async (remoteRes, { mime, name, maxBytes }) => {
        const buf = await readLimited(remoteRes, maxBytes);
        const tmp = storage.tmpFile();
        await fsp.writeFile(tmp, buf);
        return (await saveObject(tmp, name, mime)).url;
      },
    });
    res.json(result);
  } catch (err) {
    throw httpError(422, `Could not preview that link: ${err.message}`);
  }
}));

// Stored files. Served from our own origin so Telegram tokens never reach the browser.
const INLINE = /^(image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)|video\/|audio\/|application\/pdf$|text\/plain$)/;
app.get('/f/:id', asyncRoute(async (req, res) => {
  const obj = wall.object(req.params.id);
  if (!obj) throw httpError(404, 'Not found');
  const file = await storage.localPath(obj);
  res.type(obj.mime || 'application/octet-stream');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Content-Disposition', `${INLINE.test(obj.mime) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(obj.name)}`);
  res.sendFile(file, { maxAge: '365d', immutable: true, lastModified: false });
}));

app.use(express.static(path.join(root, 'public'), {
  setHeaders(res, file) {
    if (file.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "img-src 'self' https: http: data: blob:",
        "media-src 'self' https: blob:",
        "style-src 'self' 'unsafe-inline'",
        "frame-src https://www.youtube-nocookie.com https://open.spotify.com https://w.soundcloud.com https://player.vimeo.com https://embed.music.apple.com",
        "object-src 'none'",
        "base-uri 'none'",
      ].join('; '));
    }
  },
}));

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `That file is over the ${MAX_UPLOAD / 1024 / 1024} MB limit` : err.message;
    return res.status(413).json({ error: msg });
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? `Server error: ${err.message}` : err.message });
});

const server = app.listen(PORT, () => console.log(`🧱 Great Wall is up on http://localhost:${PORT}`));

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (closing) process.exit(1);
    closing = true;
    console.log('[wall] saving before exit…');
    server.close();
    try { await wall.flush(); } catch (err) { console.error(err.message); }
    process.exit(0);
  });
}
