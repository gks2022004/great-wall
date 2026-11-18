// Link previews: turn a URL into something we can pin on the wall.
//   - YouTube / Spotify / SoundCloud / Vimeo / Apple Music  -> playable embed
//   - direct image / video / audio URL                      -> downloaded and stored
//   - anything else                                         -> link card (OpenGraph)

import dns from 'node:dns/promises';
import net from 'node:net';

const UA = 'Mozilla/5.0 (compatible; GreatWallBot/1.0; link preview)';
const HTML_LIMIT = 768 * 1024;

const blocked = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) {
  blocked.addSubnet(a, p, 'ipv4');
}
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(a, p, 'ipv6');

function isBlockedIp(ip) {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  return blocked.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');
}

async function assertPublicUrl(u) {
  const url = new URL(u);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http(s) links are supported');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) throw new Error('That address is not reachable from the wall');
  return url;
}

/** fetch() that re-checks every redirect hop against the private-network blocklist. */
export async function safeFetch(u, opts = {}, hops = 5) {
  let url = await assertPublicUrl(u);
  for (let i = 0; i <= hops; i++) {
    const res = await fetch(url, {
      ...opts,
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeout || 12000),
      headers: { 'user-agent': UA, 'accept-language': 'en;q=0.9,*;q=0.5', ...(opts.headers || {}) },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = await assertPublicUrl(new URL(res.headers.get('location'), url).toString());
      continue;
    }
    return { res, url: url.toString() };
  }
  throw new Error('Too many redirects');
}

export async function readLimited(res, limit) {
  const reader = res.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) { await reader.cancel(); throw Object.assign(new Error('File is too large'), { tooLarge: true }); }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------

export function detectEmbed(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, '');

  if (['youtube.com', 'music.youtube.com', 'youtu.be', 'youtube-nocookie.com'].includes(host)) {
    let id = host === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v');
    const m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{6,})/);
    if (m) id = m[2];
    if (id && /^[\w-]{6,20}$/.test(id)) {
      const shorts = m?.[1] === 'shorts';
      const start = parseInt(u.searchParams.get('t') || '0', 10);
      return {
        provider: 'youtube',
        oembed: `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`,
        src: `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ''}`,
        w: shorts ? 300 : 480, h: shorts ? 533 : 270,
      };
    }
  }
  if (host === 'open.spotify.com') {
    const m = u.pathname.match(/^\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]+)/);
    if (m) {
      return {
        provider: 'spotify',
        oembed: `https://open.spotify.com/oembed?url=${encodeURIComponent(raw)}`,
        src: `https://open.spotify.com/embed/${m[1]}/${m[2]}`,
        w: 360, h: m[1] === 'track' || m[1] === 'episode' ? 152 : 380,
      };
    }
  }
  if (host === 'soundcloud.com' && u.pathname.split('/').filter(Boolean).length >= 2) {
    return {
      provider: 'soundcloud',
      oembed: `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(raw)}`,
      src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(raw)}&color=%23111111&visual=false&show_comments=false`,
      w: 400, h: u.pathname.includes('/sets/') ? 350 : 166,
    };
  }
  if (host === 'vimeo.com') {
    const m = u.pathname.match(/^\/(\d+)/);
    if (m) {
      return {
        provider: 'vimeo',
        oembed: `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(raw)}`,
        src: `https://player.vimeo.com/video/${m[1]}`,
        w: 480, h: 270,
      };
    }
  }
  if (host === 'music.apple.com') {
    const song = u.searchParams.get('i') || /\/song\//.test(u.pathname);
    return { provider: 'apple', src: `https://embed.music.apple.com${u.pathname}${u.search}`, w: 400, h: song ? 175 : 450 };
  }
  return null;
}

const decode = (s = '') => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

function attrs(tag) {
  const out = {};
  const re = /([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

export function parseHtml(html, base) {
  const head = html.slice(0, 400000);
  const meta = {};
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const a = attrs(tag);
    const key = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (key && a.content && !(key in meta)) meta[key] = decode(a.content);
  }
  const abs = (v) => { try { return v ? new URL(v, base).toString() : ''; } catch { return ''; } };
  let icon = '';
  for (const tag of head.match(/<link\b[^>]*>/gi) || []) {
    const a = attrs(tag);
    if (/\bicon\b/i.test(a.rel || '') && a.href) { icon = abs(decode(a.href)); if (/apple-touch/i.test(a.rel)) break; }
  }
  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return {
    title: meta['og:title'] || meta['twitter:title'] || decode(titleTag) || '',
    description: meta['og:description'] || meta['twitter:description'] || meta.description || '',
    image: abs(meta['og:image:secure_url'] || meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src']),
    siteName: meta['og:site_name'] || meta['application-name'] || '',
    favicon: icon || abs('/favicon.ico'),
  };
}

/**
 * Build a wall item description for a URL.
 * `storeRemote(url, {maxBytes, nameHint})` downloads + stores a remote file and returns its /f/ url.
 */
export async function preview(rawUrl, { storeRemote, maxRemoteBytes }) {
  let url = new URL(rawUrl.trim()).toString();
  const host = new URL(url).hostname.replace(/^www\./, '');

  const embed = detectEmbed(url);
  if (!embed) url = (await assertPublicUrl(url)).toString();
  if (embed) {
    let info = {};
    if (embed.oembed) {
      try {
        const { res } = await safeFetch(embed.oembed, { timeout: 8000 });
        if (res.ok) info = JSON.parse((await readLimited(res, 256 * 1024)).toString('utf8'));
      } catch { /* embed still works without a title */ }
    }
    return {
      type: 'embed',
      w: embed.w, h: embed.h + 30,
      data: { url, src: embed.src, provider: embed.provider, title: info.title || '', author: info.author_name || '', site: host },
    };
  }

  const { res, url: finalUrl } = await safeFetch(url);
  if (!res.ok) throw new Error(`The site answered ${res.status}`);
  const ctype = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const media = ctype.match(/^(image|video|audio)\//)?.[1];

  if (media) {
    const name = decodeURIComponent(new URL(finalUrl).pathname.split('/').pop() || `${media}`);
    let src = finalUrl;
    try {
      src = await storeRemote(res, { mime: ctype, name, maxBytes: maxRemoteBytes });
    } catch (err) {
      if (!err.tooLarge) throw err;
      // too big to keep a copy — hotlink instead
    }
    const data = { src, name, source: url };
    if (media === 'audio') data.title = name.replace(/\.[a-z0-9]+$/i, '');
    return { type: media, w: media === 'audio' ? 320 : media === 'video' ? 420 : 320, data };
  }

  if (!/html|xml/.test(ctype) && ctype) {
    await res.body?.cancel();
    return { type: 'link', w: 320, data: { url, title: decodeURIComponent(new URL(finalUrl).pathname.split('/').pop() || host), site: host } };
  }

  const html = (await readLimited(res, HTML_LIMIT).catch((e) => (e.tooLarge ? Buffer.alloc(0) : Promise.reject(e)))).toString('utf8');
  const meta = parseHtml(html, finalUrl);
  let image = meta.image;
  if (image) {
    try {
      const { res: imgRes } = await safeFetch(image, { timeout: 8000 });
      const t = (imgRes.headers.get('content-type') || '').split(';')[0];
      if (imgRes.ok && t.startsWith('image/')) image = await storeRemote(imgRes, { mime: t, name: `preview-${host}`, maxBytes: 8 * 1024 * 1024 });
      else await imgRes.body?.cancel();
    } catch { /* keep remote url as a fallback */ }
  }
  return {
    type: 'link',
    w: 320,
    data: {
      url,
      title: meta.title.slice(0, 300) || host,
      description: meta.description.slice(0, 500),
      image,
      site: meta.siteName.slice(0, 100) || host,
      favicon: meta.favicon,
    },
  };
}
