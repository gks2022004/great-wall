// Minimal Telegram Bot API client used as an object store.
//
// Files are posted as documents to a private channel; the returned file_id is
// the "object key". Bot API downloads are capped at 20 MB, so callers split
// larger files into chunks (see storage.js).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Telegram {
  constructor(token, chatId, apiBase = 'https://api.telegram.org') {
    this.api = apiBase.replace(/\/+$/, '');
    this.token = token;
    this.chatId = chatId;
  }

  async call(method, params = {}, form = null) {
    const url = `${this.api}/bot${this.token}/${method}`;
    for (let attempt = 0; ; attempt++) {
      let json;
      try {
        const res = await fetch(url, form
          ? { method: 'POST', body: form }
          : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
        json = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
      } catch (err) {
        if (attempt < 4) { await sleep(500 * 2 ** attempt); continue; }
        throw new Error(`Telegram ${method}: ${err.message}`);
      }
      if (json.ok) return json.result;
      if (json.error_code === 429 && attempt < 6) {
        await sleep(((json.parameters?.retry_after ?? 1) * 1000) + 250);
        continue;
      }
      if (json.error_code >= 500 && attempt < 4) { await sleep(500 * 2 ** attempt); continue; }
      const err = new Error(`Telegram ${method}: ${json.description || 'unknown error'}`);
      err.code = json.error_code;
      throw err;
    }
  }

  static fileOf(message) {
    const f = message.document || message.audio || message.video || message.animation
      || message.voice || message.video_note || message.sticker
      || (message.photo && message.photo[message.photo.length - 1]);
    if (!f) throw new Error('Telegram returned a message without a file');
    return f;
  }

  /** Upload a buffer as a document. Returns { fileId, messageId }. */
  async sendDocument(buffer, filename, caption = '') {
    const form = new FormData();
    form.append('chat_id', String(this.chatId));
    form.append('document', new Blob([buffer]), filename);
    if (caption) form.append('caption', caption.slice(0, 1000));
    form.append('disable_content_type_detection', 'true');
    form.append('disable_notification', 'true');
    const msg = await this.call('sendDocument', {}, form);
    return { fileId: Telegram.fileOf(msg).file_id, messageId: msg.message_id };
  }

  /** Replace the document of an existing message (used for the wall snapshot). */
  async editDocument(messageId, buffer, filename, caption = '') {
    const form = new FormData();
    form.append('chat_id', String(this.chatId));
    form.append('message_id', String(messageId));
    form.append('media', JSON.stringify({ type: 'document', media: 'attach://file', caption }));
    form.append('file', new Blob([buffer]), filename);
    const msg = await this.call('editMessageMedia', {}, form);
    return { fileId: Telegram.fileOf(msg).file_id, messageId: msg.message_id };
  }

  async download(fileId) {
    const file = await this.call('getFile', { file_id: fileId });
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${this.api}/file/bot${this.token}/${file.file_path}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      } catch (err) {
        if (attempt < 3) { await sleep(500 * 2 ** attempt); continue; }
        throw new Error(`Telegram download failed: ${err.message}`);
      }
    }
  }

  pin(messageId) {
    return this.call('pinChatMessage', { chat_id: this.chatId, message_id: messageId, disable_notification: true });
  }

  async pinnedMessage() {
    const chat = await this.call('getChat', { chat_id: this.chatId });
    return chat.pinned_message || null;
  }

  async deleteMessage(messageId) {
    try { await this.call('deleteMessage', { chat_id: this.chatId, message_id: messageId }); } catch { /* best effort */ }
  }

  me() { return this.call('getMe'); }
}
