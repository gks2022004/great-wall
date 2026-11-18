// The wall: every item and every stored object, kept in one JSON document.
// Saved to disk on every change and, when Telegram is configured, mirrored to a
// pinned message in the channel so the wall survives a fresh server / redeploy.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { newId } from './storage.js';

const SNAPSHOT_TAG = '#greatwall_state';
const SYNC_DELAY = 4000;

export const ITEM_TYPES = ['image', 'video', 'audio', 'note', 'link', 'embed', 'file'];

export class Wall {
  constructor({ dataDir, telegram }) {
    this.file = path.join(dataDir, 'wall.json');
    this.telegram = telegram;
    this.state = { items: {}, objects: {}, updatedAt: 0, snapshotMessageId: null };
    this.timer = null;
    this.syncing = Promise.resolve();
  }

  async init() {
    let local = null;
    try { local = JSON.parse(await fsp.readFile(this.file, 'utf8')); } catch { /* first run */ }

    let remote = null;
    if (this.telegram) {
      try {
        const pinned = await this.telegram.pinnedMessage();
        if (pinned?.document && (pinned.caption || '').includes(SNAPSHOT_TAG)) {
          remote = JSON.parse((await this.telegram.download(pinned.document.file_id)).toString('utf8'));
          remote.snapshotMessageId = pinned.message_id;
        }
      } catch (err) {
        console.warn(`[wall] could not load snapshot from Telegram: ${err.message}`);
      }
    }

    const pick = [local, remote].filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    if (pick) this.state = { items: {}, objects: {}, ...pick };
    if (remote && local && remote.snapshotMessageId) this.state.snapshotMessageId = remote.snapshotMessageId;
    await this.writeLocal();
    const n = Object.keys(this.state.items).length;
    console.log(`[wall] loaded ${n} item${n === 1 ? '' : 's'} from ${pick === remote && remote ? 'Telegram' : pick ? 'disk' : 'scratch'}`);
  }

  async writeLocal() {
    const tmp = `${this.file}.${newId()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(this.state));
    await fsp.rename(tmp, this.file);
  }

  async changed() {
    this.state.updatedAt = Date.now();
    await this.writeLocal();
    if (this.telegram) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.sync(), SYNC_DELAY);
    }
  }

  sync() {
    clearTimeout(this.timer);
    this.timer = null;
    this.syncing = this.syncing.then(() => this.pushSnapshot()).catch((err) => {
      console.warn(`[wall] snapshot sync failed, retrying in 30s: ${err.message}`);
      this.timer = setTimeout(() => this.sync(), 30000);
    });
    return this.syncing;
  }

  async pushSnapshot() {
    const { snapshotMessageId, ...rest } = this.state;
    const buf = Buffer.from(JSON.stringify(rest));
    const caption = `🧱 Great Wall state — ${Object.keys(rest.items).length} items — ${new Date().toISOString()}\n${SNAPSHOT_TAG}`;
    if (snapshotMessageId) {
      try {
        await this.telegram.editDocument(snapshotMessageId, buf, 'wall.json', caption);
        return;
      } catch (err) {
        if (!/not modified/i.test(err.message)) console.warn(`[wall] edit snapshot failed (${err.message}), posting a new one`);
        else return;
      }
    }
    const { messageId } = await this.telegram.sendDocument(buf, 'wall.json', caption);
    await this.telegram.pin(messageId);
    this.state.snapshotMessageId = messageId;
    await this.writeLocal();
  }

  async flush() {
    if (this.timer) await this.sync();
    await this.syncing;
  }

  // ---- items ---------------------------------------------------------------

  publicItems() {
    return Object.values(this.state.items).sort((a, b) => a.z - b.z);
  }

  maxZ() {
    return Object.values(this.state.items).reduce((m, i) => Math.max(m, i.z || 0), 0);
  }

  async addItem(input) {
    const item = { ...sanitizeItem(input, true), id: newId(), z: this.maxZ() + 1, createdAt: Date.now() };
    this.state.items[item.id] = item;
    await this.changed();
    return item;
  }

  async updateItem(id, patch) {
    const item = this.state.items[id];
    if (!item) return null;
    const clean = sanitizeItem(patch, false);
    if (clean.data) clean.data = { ...item.data, ...clean.data };
    Object.assign(item, clean, { updatedAt: Date.now() });
    await this.changed();
    return item;
  }

  /** Remove an item; returns objects that are no longer referenced by anything. */
  async removeItem(id) {
    const item = this.state.items[id];
    if (!item) return [];
    delete this.state.items[id];
    const orphans = [];
    for (const objId of referencedObjects(item)) {
      const stillUsed = Object.values(this.state.items).some((i) => referencedObjects(i).includes(objId));
      if (!stillUsed && this.state.objects[objId]) {
        orphans.push(this.state.objects[objId]);
        delete this.state.objects[objId];
      }
    }
    await this.changed();
    return orphans;
  }

  async addObject(obj) {
    this.state.objects[obj.id] = obj;
    await this.changed();
  }

  object(id) { return this.state.objects[id]; }
}

function referencedObjects(item) {
  const ids = [];
  for (const v of Object.values(item.data || {})) {
    if (typeof v === 'string') {
      const m = v.match(/^\/f\/([A-Za-z0-9_-]+)/);
      if (m) ids.push(m[1]);
    }
  }
  return ids;
}

const num = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined);

function sanitizeItem(input, creating) {
  const out = {};
  if (creating) {
    if (!ITEM_TYPES.includes(input.type)) throw httpError(400, 'unknown item type');
    out.type = input.type;
  }
  const B = 1e7;
  for (const [k, min, max] of [['x', -B, B], ['y', -B, B], ['w', 40, 4000], ['z', 0, 1e9], ['rot', -180, 180]]) {
    const v = num(input[k], min, max);
    if (v !== undefined) out[k] = v;
  }
  if (input.h === null) out.h = null;
  else if (num(input.h, 40, 4000) !== undefined) out.h = num(input.h, 40, 4000);
  if (input.data !== undefined) {
    if (typeof input.data !== 'object' || input.data === null || Array.isArray(input.data)) throw httpError(400, 'data must be an object');
    const data = {};
    for (const [k, v] of Object.entries(input.data).slice(0, 40)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(k)) continue;
      if (typeof v === 'string') data[k] = v.slice(0, 50000);
      else if (typeof v === 'number' && Number.isFinite(v)) data[k] = v;
      else if (typeof v === 'boolean' || v === null) data[k] = v;
    }
    out.data = data;
  } else if (creating) {
    out.data = {};
  }
  if (creating) {
    out.x ??= 0;
    out.y ??= 0;
    out.w ??= 300;
  }
  return out;
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
