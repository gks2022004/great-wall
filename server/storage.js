// Object storage: "put a file, get an id back, stream it later".
// Backed by Telegram when configured, otherwise by the local disk.
// Telegram objects are pulled into a size-capped disk cache when first served.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const CHUNK = 19 * 1024 * 1024; // Bot API getFile is limited to 20 MB per file

export const newId = () => crypto.randomBytes(9).toString('base64url');

export class Storage {
  constructor({ dataDir, telegram, cacheMaxBytes }) {
    this.telegram = telegram;
    this.uploadsDir = path.join(dataDir, 'uploads');
    this.cacheDir = path.join(dataDir, 'cache');
    this.tmpDir = path.join(dataDir, 'tmp');
    this.cacheMaxBytes = cacheMaxBytes;
    this.inflight = new Map();
    for (const d of [this.uploadsDir, this.cacheDir, this.tmpDir]) fs.mkdirSync(d, { recursive: true });
  }

  get backend() { return this.telegram ? 'telegram' : 'local'; }

  /** Store the file at tmpPath (moved/consumed). Returns the object record. */
  async put(tmpPath, { name, mime }) {
    const id = newId();
    const { size } = await fsp.stat(tmpPath);
    const obj = { id, name: name || 'file', mime: mime || 'application/octet-stream', size, createdAt: Date.now() };

    if (!this.telegram) {
      await fsp.rename(tmpPath, path.join(this.uploadsDir, id)).catch(async () => {
        await fsp.copyFile(tmpPath, path.join(this.uploadsDir, id));
        await fsp.rm(tmpPath, { force: true });
      });
      return { ...obj, backend: 'local' };
    }

    const chunks = [];
    const fh = await fsp.open(tmpPath, 'r');
    try {
      const parts = Math.max(1, Math.ceil(size / CHUNK));
      for (let i = 0; i < parts; i++) {
        const len = Math.min(CHUNK, size - i * CHUNK);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, i * CHUNK);
        const suffix = parts > 1 ? `.part${String(i + 1).padStart(3, '0')}` : '';
        const caption = `🧱 ${obj.name}${parts > 1 ? ` (${i + 1}/${parts})` : ''}\n#gw_${id}`;
        const { fileId, messageId } = await this.telegram.sendDocument(buf, `${id}${suffix}`, caption);
        chunks.push({ fileId, messageId, size: len });
      }
    } finally {
      await fh.close();
    }
    // Keep a warm copy so the uploader sees it instantly.
    await fsp.rename(tmpPath, path.join(this.cacheDir, id)).catch(() => fsp.rm(tmpPath, { force: true }));
    this.evict().catch(() => {});
    return { ...obj, backend: 'telegram', chunks };
  }

  /** Resolve an object to a readable local path, downloading from Telegram if needed. */
  async localPath(obj) {
    if (obj.backend === 'local') return path.join(this.uploadsDir, obj.id);
    const cached = path.join(this.cacheDir, obj.id);
    try {
      const now = new Date();
      await fsp.utimes(cached, now, now); // mark as recently used
      return cached;
    } catch { /* not cached */ }
    if (!this.telegram) throw new Error('Telegram is not configured on this server');
    if (!this.inflight.has(obj.id)) {
      const p = (async () => {
        const part = `${cached}.${newId()}.partial`;
        try {
          for (const c of obj.chunks) await fsp.appendFile(part, await this.telegram.download(c.fileId));
          await fsp.rename(part, cached);
        } catch (err) {
          await fsp.rm(part, { force: true });
          throw err;
        }
        this.evict().catch(() => {});
        return cached;
      })().finally(() => this.inflight.delete(obj.id));
      this.inflight.set(obj.id, p);
    }
    return this.inflight.get(obj.id);
  }

  async remove(obj) {
    if (obj.backend === 'local') {
      await fsp.rm(path.join(this.uploadsDir, obj.id), { force: true });
      return;
    }
    await fsp.rm(path.join(this.cacheDir, obj.id), { force: true });
    if (this.telegram) for (const c of obj.chunks || []) await this.telegram.deleteMessage(c.messageId);
  }

  /** Drop least-recently-used cache files until under the cap. */
  async evict() {
    const names = (await fsp.readdir(this.cacheDir)).filter((n) => !n.endsWith('.partial'));
    const files = await Promise.all(names.map(async (n) => {
      const st = await fsp.stat(path.join(this.cacheDir, n)).catch(() => null);
      return st && { n, size: st.size, t: st.mtimeMs };
    }));
    const list = files.filter(Boolean).sort((a, b) => a.t - b.t);
    let total = list.reduce((s, f) => s + f.size, 0);
    for (const f of list) {
      if (total <= this.cacheMaxBytes) break;
      await fsp.rm(path.join(this.cacheDir, f.n), { force: true });
      total -= f.size;
    }
  }

  tmpFile() { return path.join(this.tmpDir, `${newId()}.tmp`); }
}
