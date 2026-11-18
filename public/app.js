// Great Wall — an infinite white canvas of things you love.

const $ = (s, el = document) => el.querySelector(s);
const viewport = $('#viewport');
const world = $('#world');

const state = {
  items: new Map(),     // id -> item
  els: new Map(),       // id -> element
  canEdit: false,
  authRequired: true,
  view: { x: 0, y: 0, s: 1 },
  selected: null,
  editingText: null,
};

const MIN_ZOOM = 0.04;
const MAX_ZOOM = 6;
const NOTE_COLORS = ['#fff7b1', '#ffd6e7', '#d4ecff', '#d9f7c8', '#e7dcff', '#ffffff'];
const EMBED_HOSTS = ['https://www.youtube-nocookie.com/', 'https://open.spotify.com/', 'https://w.soundcloud.com/', 'https://player.vimeo.com/', 'https://embed.music.apple.com/'];

// ---------------------------------------------------------------------------
// helpers

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isUrl = (s) => /^https?:\/\/\S+$/i.test(s.trim());
const safeHref = (u) => (typeof u === 'string' && (/^https?:\/\//i.test(u) || /^\/f\/[\w-]+$/.test(u)) ? u : '');
const safeSrc = (u) => (typeof u === 'string' && (/^https:\/\//i.test(u) || /^\/f\/[\w-]+$/.test(u)) ? u : '');
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

const ICONS = {
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  caption: '<path d="M4 6h16M4 12h10M4 18h7"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  focus: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
};
function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.innerHTML = ICONS[name]; // static, trusted markup
  return s;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.canEdit) { state.canEdit = false; applyMode(); }
    throw new Error(json.error || `Request failed (${res.status})`);
  }
  return json;
}

function toast(msg, { error = false, sticky = false } = {}) {
  const el = h('div', { class: `toast${error ? ' error' : ''}`, text: msg }, h('div', { class: 'bar' }));
  $('#toasts').append(el);
  const ctl = {
    set: (m) => { el.firstChild.textContent = m; },
    progress: (p) => { el.querySelector('.bar').style.width = `${Math.round(p * 100)}%`; },
    close: (delay = 0) => setTimeout(() => el.remove(), delay),
    fail: (m) => { el.classList.add('error'); el.firstChild.textContent = m; setTimeout(() => el.remove(), 5000); },
  };
  if (!sticky) ctl.close(error ? 5000 : 2600);
  return ctl;
}

const dialog = $('#dialog');
function ask({ title, text = '', placeholder = '', type = 'text', ok = 'OK', value = '' }) {
  $('#dialog-title').textContent = title;
  $('#dialog-text').textContent = text;
  const input = $('#dialog-input');
  input.type = type;
  input.placeholder = placeholder;
  input.value = value;
  $('#dialog-ok').textContent = ok;
  dialog.returnValue = '';
  dialog.showModal();
  input.focus();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' ? input.value.trim() : null), { once: true });
  });
}

// ---------------------------------------------------------------------------
// view (pan / zoom)

let viewSaveTimer;
function applyView() {
  const { x, y, s } = state.view;
  world.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
  world.style.setProperty('--inv', String(1 / s));
  let g = 24 * s;
  while (g < 14) g *= 4;
  viewport.style.backgroundSize = `${g}px ${g}px`;
  viewport.style.backgroundPosition = `${x}px ${y}px`;
  $('#zoom-label').textContent = `${Math.round(s * 100)}%`;
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(() => { try { localStorage.setItem('gw:view', JSON.stringify(state.view)); } catch { /* private mode */ } }, 300);
}

const toWorld = (cx, cy) => ({ x: (cx - state.view.x) / state.view.s, y: (cy - state.view.y) / state.view.s });

function zoomAt(factor, cx = innerWidth / 2, cy = innerHeight / 2) {
  const v = state.view;
  const ns = clamp(v.s * factor, MIN_ZOOM, MAX_ZOOM);
  v.x = cx - (cx - v.x) * (ns / v.s);
  v.y = cy - (cy - v.y) * (ns / v.s);
  v.s = ns;
  applyView();
}

let anim = 0;
function animateView(target, ms = 420) {
  cancelAnimationFrame(anim);
  const from = { ...state.view };
  const t0 = performance.now();
  const ease = (t) => 1 - (1 - t) ** 3;
  const step = (now) => {
    const t = clamp((now - t0) / ms, 0, 1);
    const k = ease(t);
    // interpolate scale geometrically so zooms feel even
    const s = from.s * (target.s / from.s) ** k;
    state.view.s = s;
    state.view.x = from.x + (target.x - from.x) * k;
    state.view.y = from.y + (target.y - from.y) * k;
    applyView();
    if (t < 1) anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}

function boundsOf(ids) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const id of ids) {
    const it = state.items.get(id);
    const el = state.els.get(id);
    if (!it || !el) continue;
    minX = Math.min(minX, it.x); minY = Math.min(minY, it.y);
    maxX = Math.max(maxX, it.x + el.offsetWidth); maxY = Math.max(maxY, it.y + el.offsetHeight);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function viewFor(b, pad = 80, maxScale = 1) {
  const W = innerWidth; const H = innerHeight;
  const s = clamp(Math.min((W - pad * 2) / (b.maxX - b.minX || 1), (H - pad * 2) / (b.maxY - b.minY || 1)), MIN_ZOOM, maxScale);
  return { s, x: W / 2 - ((b.minX + b.maxX) / 2) * s, y: H / 2 - ((b.minY + b.maxY) / 2) * s };
}

function fitAll(animate = true) {
  const b = boundsOf([...state.items.keys()]);
  const target = b ? viewFor(b) : { s: 1, x: innerWidth / 2, y: innerHeight / 2 };
  if (animate) animateView(target); else { Object.assign(state.view, target); applyView(); }
}

function focusItem(id) {
  const b = boundsOf([id]);
  if (b) animateView(viewFor(b, 60, 3));
}

// ---------------------------------------------------------------------------
// rendering items

function placeEl(el, it) {
  el.style.transform = `translate(${it.x}px, ${it.y}px)${it.rot ? ` rotate(${it.rot}deg)` : ''}`;
  el.style.width = `${it.w}px`;
  el.style.height = it.h ? `${it.h}px` : '';
  el.style.zIndex = String(it.z || 0);
}

function renderItem(it) {
  let el = state.els.get(it.id);
  const fresh = !el;
  if (fresh) {
    el = h('div', { class: `item ${it.type}`, 'data-id': it.id });
    state.els.set(it.id, el);
    world.append(el);
  }
  placeEl(el, it);
  el.replaceChildren(h('div', { class: 'body' }, renderBody(it)), renderControls(it), h('div', { class: `resize${it.h ? '' : ' w-only'}` }));
  if (it.type === 'note') el.style.setProperty('--note', it.data.color || NOTE_COLORS[0]);
  el.classList.toggle('selected', state.selected === it.id);
  updateCount();
  return el;
}

function captionEl(it) {
  return h('div', { class: 'caption', text: it.data.caption || '', 'data-field': 'caption' });
}

function renderBody(it) {
  const d = it.data || {};
  switch (it.type) {
    case 'image': {
      const img = h('img', { src: safeSrc(d.src) || safeHref(d.src), alt: d.caption || d.name || '', loading: 'lazy', decoding: 'async', draggable: 'false', referrerpolicy: 'no-referrer' });
      if (d.ratio > 0) img.style.aspectRatio = String(d.ratio); // reserve the right height before it loads
      img.addEventListener('load', () => updateCount());
      return [img, captionEl(it)];
    }
    case 'video':
      return [h('video', { src: safeSrc(d.src) || safeHref(d.src), controls: true, preload: 'metadata', playsinline: true, loop: !!d.loop, style: { aspectRatio: String(d.ratio > 0 ? d.ratio : 16 / 9) } }), captionEl(it)];
    case 'audio': {
      const audio = h('audio', { src: safeSrc(d.src) || safeHref(d.src), controls: true, preload: 'metadata' });
      const disc = h('div', { class: `disc${d.recording ? ' rec' : ''}` }, d.recording ? icon('mic') : null);
      audio.addEventListener('play', () => { if (!d.recording) disc.classList.add('spin'); pauseOthers(audio); });
      audio.addEventListener('pause', () => disc.classList.remove('spin'));
      const sub = d.recording ? `Voice note${d.duration ? ` · ${fmtDur(d.duration)}` : ''}` : (d.artist || 'Song');
      return h('div', {},
        h('div', { class: 'audio-card' }, disc, h('div', { class: 'audio-meta' },
          h('div', { class: 'audio-title', text: d.title || d.name || 'Untitled', 'data-field': 'title', title: d.title || '' }),
          h('div', { class: 'audio-sub', text: sub }))),
        audio);
    }
    case 'note':
      return h('div', { class: 'note-text', text: d.text || '', 'data-field': 'text' });
    case 'link': {
      const href = safeHref(d.url);
      const host = (() => { try { return new URL(href).hostname.replace(/^www\./, ''); } catch { return ''; } })();
      const thumb = safeSrc(d.image) || safeHref(d.image);
      const fav = safeSrc(d.favicon) || safeHref(d.favicon);
      return h('a', { class: 'link-card', href, target: '_blank', rel: 'noopener noreferrer', draggable: 'false' },
        thumb ? h('img', { class: 'thumb', src: thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', draggable: 'false', onerror: (e) => e.target.remove() }) : null,
        h('div', { class: 'meta' },
          h('div', { class: 'site' }, fav ? h('img', { src: fav, alt: '', referrerpolicy: 'no-referrer', onerror: (e) => e.target.remove() }) : icon('link'), h('span', { text: d.site || host })),
          h('div', { class: 'title', text: d.title || href }),
          d.description ? h('div', { class: 'desc', text: d.description }) : null));
    }
    case 'embed': {
      const src = EMBED_HOSTS.some((p) => (d.src || '').startsWith(p)) ? d.src : '';
      const label = [d.title, d.author].filter(Boolean).join(' — ') || d.site || d.provider || 'Embed';
      return [
        h('div', { class: 'grip' }, icon(d.provider === 'youtube' || d.provider === 'vimeo' ? 'play' : 'music'), h('span', { text: label }),
          safeHref(d.url) ? h('a', { href: safeHref(d.url), target: '_blank', rel: 'noopener noreferrer', title: 'Open original' }, icon('open')) : null),
        src ? h('iframe', { src, loading: 'lazy', allow: 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture', allowfullscreen: true, referrerpolicy: 'strict-origin-when-cross-origin', title: label }) : null,
      ];
    }
    case 'file':
    default: {
      const ext = (d.name || '').split('.').pop().slice(0, 4);
      return h('a', { class: 'file-card', href: safeHref(d.src), target: '_blank', rel: 'noopener', draggable: 'false' },
        h('div', { class: 'file-icon', text: ext || 'file' }),
        h('div', { style: { minWidth: 0 } }, h('div', { class: 'file-name', text: d.name || 'File' }), h('div', { class: 'file-size', text: d.size ? fmtSize(d.size) : '' })));
    }
  }
}

const fmtDur = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

function pauseOthers(except) {
  for (const m of document.querySelectorAll('audio, video')) if (m !== except && !m.paused) m.pause();
}
document.addEventListener('play', (e) => { if (e.target.tagName === 'VIDEO') pauseOthers(e.target); }, true);

function renderControls(it) {
  const btn = (name, title, onclick, cls = '') => h('button', { title, class: cls, onclick: (e) => { e.stopPropagation(); onclick(); } }, icon(name));
  const kids = [];
  if (it.type === 'note') {
    for (const c of NOTE_COLORS) {
      kids.push(h('button', { title: 'Color', onclick: (e) => { e.stopPropagation(); updateItem(it.id, { data: { color: c } }, true); } },
        h('span', { class: 'swatch', style: { background: c } })));
    }
    kids.push(h('span', { class: 'sep' }));
  }
  if (['image', 'video'].includes(it.type)) kids.push(btn('caption', 'Caption', () => startTextEdit(it.id, 'caption')));
  if (it.type === 'audio') kids.push(btn('caption', 'Rename', () => startTextEdit(it.id, 'title')));
  if (['image', 'video', 'link', 'embed'].includes(it.type)) kids.push(btn('focus', 'Zoom to this', () => focusItem(it.id)));
  const href = safeHref(it.data.url || it.data.src);
  if (href) kids.push(h('a', { href, target: '_blank', rel: 'noopener noreferrer', title: it.data.url ? 'Open link' : 'Open file' }, icon(it.data.url ? 'open' : 'download')));
  kids.push(btn('trash', 'Delete (Del)', () => deleteItem(it.id), 'danger'));
  return h('div', { class: 'controls', onpointerdown: (e) => e.stopPropagation() }, kids);
}

function updateCount() {
  const n = state.items.size;
  $('#count').textContent = n ? `· ${n} thing${n === 1 ? '' : 's'}` : '';
  $('#empty').hidden = n > 0;
}

// ---------------------------------------------------------------------------
// selection & item mutations

function select(id) {
  if (state.selected === id) return;
  if (state.selected) state.els.get(state.selected)?.classList.remove('selected');
  state.selected = id;
  if (id) state.els.get(id)?.classList.add('selected');
}

function maxZ() { let m = 0; for (const it of state.items.values()) m = Math.max(m, it.z || 0); return m; }

async function createItem(partial) {
  const it = await api('POST', '/api/items', partial);
  state.items.set(it.id, it);
  renderItem(it);
  if (state.canEdit) select(it.id);
  return it;
}

async function updateItem(id, patch, rerender = false) {
  const it = state.items.get(id);
  if (!it) return;
  const prev = structuredClone(it);
  Object.assign(it, patch, patch.data ? { data: { ...it.data, ...patch.data } } : {});
  if (rerender) renderItem(it); else placeEl(state.els.get(id), it);
  try {
    await api('PATCH', `/api/items/${id}`, patch);
  } catch (err) {
    state.items.set(id, prev);
    renderItem(prev);
    toast(err.message, { error: true });
  }
}

async function deleteItem(id) {
  const it = state.items.get(id);
  const el = state.els.get(id);
  if (!it) return;
  state.items.delete(id);
  state.els.delete(id);
  el?.remove();
  if (state.selected === id) state.selected = null;
  updateCount();
  try {
    await api('DELETE', `/api/items/${id}`);
  } catch (err) {
    state.items.set(id, it);
    renderItem(it);
    toast(err.message, { error: true });
  }
}

function startTextEdit(id, field) {
  const el = state.els.get(id);
  const target = el?.querySelector(`[data-field="${field}"]`);
  if (!target || !state.canEdit) return;
  state.editingText = target;
  target.contentEditable = 'plaintext-only';
  if (target.contentEditable !== 'plaintext-only') target.contentEditable = 'true';
  target.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(target);
  range.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const onPaste = (e) => {
    if (target.contentEditable === 'true') { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); }
  };
  const finish = (save) => {
    target.removeEventListener('keydown', onKey);
    target.removeEventListener('paste', onPaste);
    target.contentEditable = 'false';
    target.removeAttribute('contenteditable');
    state.editingText = null;
    const text = target.innerText.replace(/\n$/, '');
    const it = state.items.get(id);
    if (!it) return;
    if (!save) { target.textContent = it.data[field] || ''; return; }
    if (text !== (it.data[field] || '')) updateItem(id, { data: { [field]: text } });
  };
  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { target.blur(); }
    if (e.key === 'Enter' && (field !== 'text' || e.metaKey || e.ctrlKey)) { e.preventDefault(); target.blur(); }
  };
  target.addEventListener('keydown', onKey);
  target.addEventListener('paste', onPaste);
  target.addEventListener('blur', () => finish(true), { once: true });
}

// ---------------------------------------------------------------------------
// pointer interactions

const pointers = new Map();
let gesture = null;   // { kind: 'pan'|'move'|'resize'|'pinch', ... }
let spaceDown = false;
let suppressClick = false;

const INTERACTIVE = 'audio, video, iframe, input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"], .controls';

viewport.addEventListener('pointerdown', (e) => {
  if (dialog.open) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 2) {
    // second finger: switch to pinch-zoom
    if (gesture?.kind === 'move' || gesture?.kind === 'resize') finishGesture();
    const [a, b] = [...pointers.values()];
    gesture = { kind: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    return;
  }
  if (pointers.size > 2) return;

  const itemEl = e.target.closest('.item');
  const id = itemEl?.dataset.id;
  const interactive = e.target.closest(INTERACTIVE);

  if (e.button === 1 || spaceDown || (!itemEl && e.button === 0) || (itemEl && !state.canEdit && !interactive && e.button === 0)) {
    if (!itemEl && state.editingText) state.editingText.blur();
    if (!itemEl) select(null);
    e.preventDefault();
    gesture = { kind: 'pan', pid: e.pointerId, sx: e.clientX, sy: e.clientY, vx: state.view.x, vy: state.view.y, moved: 0 };
    viewport.classList.add('panning');
    return;
  }
  if (!itemEl || !state.canEdit || e.button !== 0 || interactive) return;

  if (state.editingText && !itemEl.contains(state.editingText)) state.editingText.blur();
  select(id);
  const it = state.items.get(id);
  if ((it.z || 0) < maxZ()) { it.z = maxZ() + 1; itemEl.style.zIndex = it.z; gestureZ = true; } else gestureZ = false;

  e.preventDefault();
  if (e.target.classList.contains('resize')) {
    gesture = { kind: 'resize', pid: e.pointerId, id, sx: e.clientX, sy: e.clientY, w: it.w, h: it.h || itemEl.offsetHeight, hasH: !!it.h, moved: 0 };
  } else {
    gesture = { kind: 'move', pid: e.pointerId, id, sx: e.clientX, sy: e.clientY, x: it.x, y: it.y, moved: 0 };
    itemEl.classList.add('lifted');
  }
  document.body.classList.add('dragging');
});
let gestureZ = false;

viewport.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!gesture) return;
  const s = state.view.s;

  if (gesture.kind === 'pinch' && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    state.view.x += mid.x - gesture.mid.x;
    state.view.y += mid.y - gesture.mid.y;
    zoomAt(dist / (gesture.dist || dist), mid.x, mid.y);
    gesture.dist = dist; gesture.mid = mid;
    return;
  }
  const dx = e.clientX - gesture.sx;
  const dy = e.clientY - gesture.sy;
  gesture.moved = Math.max(gesture.moved, Math.hypot(dx, dy));
  // capture only once it's really a drag, so plain clicks still reach links & buttons
  if (gesture.moved > 3 && !gesture.captured && gesture.pid === e.pointerId) {
    gesture.captured = true;
    try { viewport.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  }

  if (gesture.kind === 'pan') {
    state.view.x = gesture.vx + dx;
    state.view.y = gesture.vy + dy;
    applyView();
  } else if (gesture.kind === 'move') {
    const it = state.items.get(gesture.id);
    const el = state.els.get(gesture.id);
    if (!it || !el) return;
    if (gesture.moved > 3) el.classList.add('moving');
    it.x = Math.round(gesture.x + dx / s);
    it.y = Math.round(gesture.y + dy / s);
    placeEl(el, it);
  } else if (gesture.kind === 'resize') {
    const it = state.items.get(gesture.id);
    const el = state.els.get(gesture.id);
    if (!it || !el) return;
    el.classList.add('moving');
    it.w = Math.round(clamp(gesture.w + dx / s, 80, 4000));
    if (gesture.hasH) it.h = Math.round(clamp(gesture.h + dy / s, 60, 4000));
    placeEl(el, it);
  }
});

function finishGesture() {
  const g = gesture;
  gesture = null;
  viewport.classList.remove('panning');
  document.body.classList.remove('dragging');
  if (!g) return;
  if (g.moved > 4) suppressClick = true;
  if (g.kind === 'move' || g.kind === 'resize') {
    const el = state.els.get(g.id);
    el?.classList.remove('lifted', 'moving');
    const it = state.items.get(g.id);
    if (!it) return;
    const patch = {};
    if (g.kind === 'move' && g.moved > 3) Object.assign(patch, { x: it.x, y: it.y });
    if (g.kind === 'resize') Object.assign(patch, { w: it.w }, g.hasH ? { h: it.h } : {});
    if (gestureZ) patch.z = it.z;
    if (Object.keys(patch).length) {
      api('PATCH', `/api/items/${g.id}`, patch).catch((err) => toast(err.message, { error: true }));
    }
  }
}

const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (gesture?.kind === 'pinch') {
    if (pointers.size < 2) {
      gesture = null;
      // continue panning with the remaining finger
      const rest = [...pointers.values()][0];
      if (rest) gesture = { kind: 'pan', sx: rest.x, sy: rest.y, vx: state.view.x, vy: state.view.y, moved: 10 };
    }
    return;
  }
  if (pointers.size === 0) finishGesture();
};
viewport.addEventListener('pointerup', endPointer);
viewport.addEventListener('pointercancel', endPointer);

// a drag that ends on top of a link must not open it
window.addEventListener('click', (e) => {
  if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); }
}, true);
viewport.addEventListener('pointerdown', () => { suppressClick = false; }, true);

// In edit mode, a single click on a link card selects it; double-click (or the ↗ button) opens it.
viewport.addEventListener('click', (e) => {
  if (!state.canEdit) return;
  const a = e.target.closest('.link-card, .file-card');
  if (a && !e.metaKey && !e.ctrlKey) e.preventDefault();
});

viewport.addEventListener('dblclick', (e) => {
  if (e.target.closest(INTERACTIVE)) return;
  const itemEl = e.target.closest('.item');
  if (!itemEl) {
    if (!state.canEdit) return;
    const p = toWorld(e.clientX, e.clientY);
    addNote(p.x - 110, p.y - 110);
    return;
  }
  const id = itemEl.dataset.id;
  const it = state.items.get(id);
  if (state.canEdit && it.type === 'note') return startTextEdit(id, 'text');
  if (state.canEdit && it.type === 'audio' && e.target.closest('.audio-title')) return startTextEdit(id, 'title');
  if (state.canEdit && (it.type === 'link' || it.type === 'file')) {
    const href = safeHref(it.data.url || it.data.src);
    if (href) window.open(href, '_blank', 'noopener');
    return;
  }
  if (['image', 'video', 'embed', 'link'].includes(it.type)) focusItem(id);
});

// wheel: pinch / ctrl+wheel / mouse wheel zoom, two-finger trackpad scroll pans
let wheelKind = null; let wheelAt = 0;
viewport.addEventListener('wheel', (e) => {
  if (e.target.closest('.note-text') && e.target.closest('.note-text').scrollHeight > e.target.closest('.note-text').clientHeight && !e.ctrlKey) return;
  e.preventDefault();
  const now = performance.now();
  if (now - wheelAt > 250) wheelKind = null;
  wheelAt = now;
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
  const dx = e.deltaX * unit; const dy = e.deltaY * unit;
  if (e.ctrlKey || e.metaKey) {
    zoomAt(Math.exp(-dy * 0.01), e.clientX, e.clientY);
    return;
  }
  if (!wheelKind) wheelKind = (e.deltaMode !== 0 || (dx === 0 && Math.abs(dy) >= 50 && Number.isInteger(dy))) ? 'mouse' : 'trackpad';
  if (wheelKind === 'mouse' && !e.shiftKey) {
    zoomAt(Math.exp(-dy * 0.0015), e.clientX, e.clientY);
  } else {
    state.view.x -= e.shiftKey && dx === 0 ? dy : dx;
    state.view.y -= e.shiftKey && dx === 0 ? 0 : dy;
    applyView();
  }
}, { passive: false });

// Safari trackpad pinch
let gestureScale = 1;
viewport.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureScale = 1; });
viewport.addEventListener('gesturechange', (e) => { e.preventDefault(); zoomAt(e.scale / gestureScale, e.clientX, e.clientY); gestureScale = e.scale; });

// ---------------------------------------------------------------------------
// keyboard

const typing = () => {
  const a = document.activeElement;
  return dialog.open || state.editingText || (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable));
};

window.addEventListener('keydown', (e) => {
  if (e.key === ' ' && !typing()) { spaceDown = true; viewport.classList.add('panning'); e.preventDefault(); }
  if (typing() || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if ((k === 'delete' || k === 'backspace') && state.selected && state.canEdit) { e.preventDefault(); deleteItem(state.selected); }
  else if (k === 'escape') select(null);
  else if (k === 'f') fitAll();
  else if (k === '0') animateView({ s: 1, x: innerWidth / 2 - toWorld(innerWidth / 2, innerHeight / 2).x, y: innerHeight / 2 - toWorld(innerWidth / 2, innerHeight / 2).y });
  else if (k === '=' || k === '+') zoomAt(1.25);
  else if (k === '-' || k === '_') zoomAt(0.8);
  else if (k === 'enter' && state.selected) {
    const it = state.items.get(state.selected);
    if (it?.type === 'note') { e.preventDefault(); startTextEdit(it.id, 'text'); }
  } else if (state.canEdit && k === 'n') { e.preventDefault(); addNote(); }
  else if (state.canEdit && k === 'l') { e.preventDefault(); promptLink(); }
  else if (state.canEdit && k === 'u') $('#file-input').click();
  else if (state.canEdit && k === 'r') toggleRecording();
  else if (k.startsWith('arrow')) {
    const d = e.shiftKey ? 300 : 80;
    if (k === 'arrowleft') state.view.x += d;
    if (k === 'arrowright') state.view.x -= d;
    if (k === 'arrowup') state.view.y += d;
    if (k === 'arrowdown') state.view.y -= d;
    applyView();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') { spaceDown = false; if (!gesture) viewport.classList.remove('panning'); }
});

// ---------------------------------------------------------------------------
// adding things

const centerPoint = () => toWorld(innerWidth / 2, innerHeight / 2);

/** Top-left corner for a w×h item: as close to `near` as possible without covering anything. */
const reserved = new Set(); // spots handed out but not yet created (parallel uploads)
function findSpot(w, hh, near = centerPoint()) {
  const spot = findFree(w, hh, near);
  const r = { ...spot, w, h: hh };
  reserved.add(r);
  setTimeout(() => reserved.delete(r), 4000);
  return spot;
}
function findFree(w, hh, near) {
  const gap = 24;
  const rects = [...state.items.values()].map((it) => {
    const el = state.els.get(it.id);
    return { x: it.x, y: it.y, w: el?.offsetWidth || it.w, h: el?.offsetHeight || it.h || 200 };
  }).concat([...reserved]);
  const free = (x, y) => rects.every((r) => x + w + gap <= r.x || r.x + r.w + gap <= x || y + hh + gap <= r.y || r.y + r.h + gap <= y);
  const cx = Math.round(near.x - w / 2);
  const cy = Math.round(near.y - hh / 2);
  if (free(cx, cy)) return { x: cx, y: cy };
  const step = 40;
  for (let ring = 1; ring < 120; ring++) {
    let best = null; let bd = Infinity;
    for (let i = -ring; i <= ring; i++) {
      for (const [dx, dy] of [[i, -ring], [i, ring], [-ring, i], [ring, i]]) {
        const x = cx + dx * step; const y = cy + dy * step;
        const d = dx * dx + dy * dy * 1.6; // prefer spreading sideways, like a wall
        if (d < bd && free(x, y)) { bd = d; best = { x, y }; }
      }
    }
    if (best) return best;
  }
  return { x: cx, y: cy };
}

const jitter = () => Math.round((Math.random() * 4 - 2) * 10) / 10;

function addNote(x, y, text = '') {
  if (x == null) ({ x, y } = findSpot(220, 220));
  return createItem({ type: 'note', x: Math.round(x), y: Math.round(y), w: 220, h: 220, rot: jitter(), data: { text, color: NOTE_COLORS[Math.floor(Math.random() * 4)] } })
    .then((it) => { if (!text) setTimeout(() => startTextEdit(it.id, 'text'), 30); return it; })
    .catch((err) => toast(err.message, { error: true }));
}

function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let json = {};
      try { json = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(json);
      else reject(new Error(json.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Network error while uploading'));
    const fd = new FormData();
    fd.append('file', file, file.name);
    xhr.send(fd);
  });
}

function imageSize(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => { resolve(null); URL.revokeObjectURL(url); };
    img.src = url;
  });
}

function mediaDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = () => { resolve(Number.isFinite(a.duration) ? a.duration : 0); URL.revokeObjectURL(url); };
    a.onerror = () => { resolve(0); URL.revokeObjectURL(url); };
    a.src = url;
  });
}

const kindOf = (file) => {
  const t = file.type || '';
  if (/^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/.test(t)) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (!t && /\.(mp3|m4a|flac|wav|ogg|opus|aac)$/i.test(file.name)) return 'audio';
  return 'file';
};

async function addFile(file, at, extra = {}) { // eslint-disable-line no-param-reassign
  const t = toast(`Uploading ${file.name}…`, { sticky: true });
  try {
    const kind = kindOf(file);
    let w = 320;
    let estH = 110;
    if (kind === 'image') {
      const dim = await imageSize(file);
      if (dim) {
        const ratio = dim.w / dim.h;
        w = Math.round(clamp(ratio >= 1 ? 360 : 260, 120, dim.w));
        if (dim.w < 200) w = Math.max(120, dim.w);
        estH = w / ratio;
        extra = { ratio: Math.round(ratio * 1000) / 1000, ...extra };
      } else estH = w;
    } else if (kind === 'video') { w = 420; estH = 236; }
    else if (kind === 'audio') w = 320;
    else { w = 280; estH = 80; }

    const duration = kind === 'audio' ? await mediaDuration(file) : 0;
    const up = await uploadFile(file, (p) => { t.progress(p); t.set(p < 1 ? `Uploading ${file.name}… ${Math.round(p * 100)}%` : `Saving ${file.name} to the wall…`); });
    const data = { src: up.url, name: up.name, size: up.size, mime: up.mime, ...extra };
    if (kind === 'audio') { data.title ??= up.name.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' '); if (duration) data.duration = Math.round(duration); }
    const pos = at || findSpot(w, estH);
    await createItem({ type: kind, x: Math.round(pos.x), y: Math.round(pos.y), w, data });
    t.close();
  } catch (err) {
    t.fail(`${file.name}: ${err.message}`);
  }
}

async function addFiles(files, at) {
  files = [...files];
  const cols = Math.ceil(Math.sqrt(files.length));
  // dropped at a spot: lay them out in a grid there; otherwise each finds free space near the center
  const queue = files.map((f, i) => () => addFile(f, at ? { x: at.x - 160 + (i % cols) * 380, y: at.y - 120 + Math.floor(i / cols) * 340 } : null));
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => { while (queue.length) await queue.shift()(); });
  await Promise.all(workers);
}

async function addLink(url, at) {
  const t = toast('Fetching preview…', { sticky: true });
  try {
    const pre = await api('POST', '/api/preview', { url });
    const w = pre.w || 320;
    const estH = pre.h || { link: pre.data?.image ? 290 : 130, image: w, video: w * 0.5625, audio: 110 }[pre.type] || 200;
    const p = at ? { x: at.x - w / 2, y: at.y - 100 } : findSpot(w, estH);
    await createItem({ ...pre, x: Math.round(p.x), y: Math.round(p.y) });
    t.close();
  } catch (err) {
    t.fail(err.message);
  }
}

async function promptLink() {
  const url = await ask({ title: 'Pin a link', text: 'Websites, YouTube, Spotify, SoundCloud, image / meme / mp3 URLs…', placeholder: 'https://', type: 'url', ok: 'Add' });
  if (!url) return;
  addLink(/^https?:\/\//i.test(url) ? url : `https://${url}`);
}

// ---------------------------------------------------------------------------
// voice recording

let recorder = null;
let recChunks = [];
let recStart = 0;
let recTimer = 0;
let recCancelled = false;

async function toggleRecording() {
  if (recorder) { recorder.stop(); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    toast('Microphone access was blocked', { error: true });
    return;
  }
  const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  recChunks = [];
  recCancelled = false;
  recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  recorder.onstop = async () => {
    stream.getTracks().forEach((tr) => tr.stop());
    clearInterval(recTimer);
    $('#recorder').hidden = true;
    $('[data-action="record"]').classList.remove('active');
    const secs = (Date.now() - recStart) / 1000;
    recorder = null;
    if (recCancelled || !recChunks.length) return;
    const type = recChunks[0].type || mime || 'audio/webm';
    const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
    const when = new Date();
    const file = new File(recChunks, `recording-${when.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`, { type: type.split(';')[0] });
    const title = `Voice note · ${when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    addFile(file, null, { recording: true, title, duration: Math.round(secs) });
  };
  recorder.start(1000);
  recStart = Date.now();
  $('#recorder').hidden = false;
  $('[data-action="record"]').classList.add('active');
  $('#rec-time').textContent = '0:00';
  recTimer = setInterval(() => { $('#rec-time').textContent = fmtDur((Date.now() - recStart) / 1000); }, 250);
}
$('#rec-stop').addEventListener('click', () => recorder?.stop());
$('#rec-cancel').addEventListener('click', () => { recCancelled = true; recorder?.stop(); });

// ---------------------------------------------------------------------------
// toolbar, paste, drop

$('#toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  b?.blur();
  const action = b?.dataset.action;
  if (action === 'note') addNote();
  if (action === 'upload') $('#file-input').click();
  if (action === 'link') promptLink();
  if (action === 'record') toggleRecording();
});
$('#file-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

$('#zoom').addEventListener('click', (e) => {
  const z = e.target.closest('button')?.dataset.zoom;
  if (z === 'in') zoomAt(1.25);
  if (z === 'out') zoomAt(0.8);
  if (z === 'fit') fitAll();
  if (z === 'reset') {
    const c = toWorld(innerWidth / 2, innerHeight / 2);
    animateView({ s: 1, x: innerWidth / 2 - c.x, y: innerHeight / 2 - c.y });
  }
});

window.addEventListener('paste', (e) => {
  if (!state.canEdit || typing()) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); return; }
  const text = e.clipboardData?.getData('text/plain')?.trim();
  if (!text) return;
  e.preventDefault();
  if (isUrl(text)) addLink(text);
  else addNote(null, null, text.slice(0, 5000));
});

let dragDepth = 0;
const dragHasStuff = (e) => [...(e.dataTransfer?.types || [])].some((t) => t === 'Files' || t === 'text/uri-list' || t === 'text/plain');
window.addEventListener('dragenter', (e) => { if (state.canEdit && dragHasStuff(e)) { dragDepth++; $('#drop-hint').hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-hint').hidden = true; } });
window.addEventListener('dragover', (e) => { if (state.canEdit && dragHasStuff(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  dragDepth = 0;
  $('#drop-hint').hidden = true;
  if (!state.canEdit) return;
  e.preventDefault();
  const at = toWorld(e.clientX, e.clientY);
  const files = [...(e.dataTransfer.files || [])];
  if (files.length) { addFiles(files, at); return; }
  const uri = (e.dataTransfer.getData('text/uri-list') || '').split('\n').find((l) => l && !l.startsWith('#'));
  const text = (uri || e.dataTransfer.getData('text/plain') || '').trim();
  if (!text) return;
  if (isUrl(text)) addLink(text, at);
  else addNote(at.x - 110, at.y - 110, text.slice(0, 5000));
});

// ---------------------------------------------------------------------------
// auth

function applyMode() {
  document.body.classList.toggle('edit', state.canEdit);
  $('#toolbar').hidden = !state.canEdit;
  $('#login-btn').hidden = state.canEdit || !state.authRequired;
  $('#logout-btn').hidden = !state.canEdit || !state.authRequired;
  for (const el of document.querySelectorAll('[data-edit-only]')) el.hidden = !state.canEdit;
  if (!state.canEdit) select(null);
}

$('#login-btn').addEventListener('click', async () => {
  const password = await ask({ title: 'Unlock the wall', text: 'Enter your password to add and arrange things.', type: 'password', ok: 'Unlock' });
  if (!password) return;
  try {
    await api('POST', '/api/login', { password });
    await load(false);
    toast('Unlocked — drop anything onto the wall');
  } catch (err) {
    toast(err.message, { error: true });
  }
});
$('#logout-btn').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  state.canEdit = false;
  applyMode();
});

// ---------------------------------------------------------------------------
// boot

async function load(resetView = true) {
  const wall = await api('GET', '/api/wall');
  state.canEdit = wall.canEdit;
  state.authRequired = wall.authRequired;
  state.items = new Map(wall.items.map((it) => [it.id, it]));
  for (const el of state.els.values()) el.remove();
  state.els.clear();
  for (const it of wall.items) renderItem(it);
  updateCount();
  applyMode();
  if (resetView) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('gw:view')); } catch { /* ignore */ }
    if (saved && Number.isFinite(saved.s) && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      Object.assign(state.view, saved);
      applyView();
    } else {
      requestAnimationFrame(() => fitAll(false));
    }
  }
}

// the viewport is overflow:hidden but focus()/scrollIntoView can still scroll it — keep it pinned
viewport.addEventListener('scroll', () => { viewport.scrollTop = 0; viewport.scrollLeft = 0; });

applyView();
load().catch((err) => toast(`Could not load the wall: ${err.message}`, { error: true, sticky: true }));
