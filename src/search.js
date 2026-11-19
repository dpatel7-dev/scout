'use strict';
// Looking things up: search the web, then read the best pages.
//
// Where results come from, in order:
//   - Brave Search, if you added your own free Brave key (the most reliable)
//   - DuckDuckGo's plain HTML page (no key; the same page you'd get in a browser)
//   - Wikipedia (no key), always added for background on people, places and things
// Each page is fetched once, with a short time limit, and boiled down to its
// readable text. Nothing is sent anywhere except to the sites themselves.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const url = (name, dflt) => (process.env[`SCOUT_URL_${name}`] || dflt).replace(/\/+$/, '');

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•' };
function decode(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return ''; } }
    return ENT[e.toLowerCase()] !== undefined ? ENT[e.toLowerCase()] : all;
  });
}
const text = (html) => decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

async function get(u, { timeout = 5000, signal, headers = {}, max = 1.5e6 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  const stop = () => ac.abort();
  if (signal) signal.addEventListener('abort', stop, { once: true });
  try {
    const res = await fetch(u, { signal: ac.signal, redirect: 'follow', headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', ...headers } });
    const type = res.headers.get('content-type') || '';
    // read at most `max` bytes: some pages are huge
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (got > max) { try { await reader.cancel(); } catch { /* fine */ } break; }
    }
    return { ok: res.ok, status: res.status, type, url: res.url || u, body: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8') };
  } finally {
    clearTimeout(t);
    if (signal) signal.removeEventListener('abort', stop);
  }
}

// ── the search engines ──────────────────────────────────────────────────────

/** DuckDuckGo's HTML results page → [{ title, url, snippet }]. */
function parseDuck(html) {
  const out = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*result__a|$)/g;
  let m;
  while ((m = re.exec(html)) && out.length < 12) {
    let href = decode(m[1]);
    const u = /[?&]uddg=([^&]+)/.exec(href);
    if (u) href = decodeURIComponent(u[1]);
    if (href.startsWith('//')) href = 'https:' + href;
    if (!/^https?:\/\//.test(href) || /duckduckgo\.com\/y\.js|\/\/duckduckgo\.com\/l\/\?/.test(href)) continue; // ads
    const sn = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(m[3]);
    out.push({ title: text(m[2]), url: href, snippet: sn ? text(sn[1]) : '' });
  }
  return out;
}

async function duck(q, { signal } = {}) {
  const r = await get(`${url('DDG', 'https://html.duckduckgo.com/html')}/?q=${encodeURIComponent(q)}&kl=us-en`, { signal, timeout: 6000 });
  if (!r.ok) throw new Error(`DuckDuckGo answered ${r.status}`);
  const list = parseDuck(r.body);
  if (!list.length && /anomaly|captcha|unusual traffic/i.test(r.body)) throw new Error('DuckDuckGo wants a person check right now');
  return list;
}

async function brave(q, key, { signal } = {}) {
  const r = await get(`${url('BRAVE', 'https://api.search.brave.com/res/v1/web/search')}?q=${encodeURIComponent(q)}&count=10`, { signal, headers: { accept: 'application/json', 'x-subscription-token': key } });
  if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? "Brave didn't accept your key" : `Brave answered ${r.status}`);
  const j = JSON.parse(r.body);
  return ((j.web && j.web.results) || []).map((x) => ({ title: text(x.title), url: x.url, snippet: text(x.description) }));
}

/** The Wikipedia article that best matches, as a source with its summary already read. */
async function wikipedia(q, { signal } = {}) {
  const base = url('WIKI', 'https://en.wikipedia.org');
  const r = await get(`${base}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=1&utf8=1`, { signal, timeout: 4000, headers: { accept: 'application/json' } });
  if (!r.ok) return null;
  const hit = ((JSON.parse(r.body).query || {}).search || [])[0];
  if (!hit) return null;
  const title = hit.title;
  const s = await get(`${base}/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`, { signal, timeout: 4000, headers: { accept: 'application/json' } });
  if (!s.ok) return null;
  const j = JSON.parse(s.body);
  if (!j.extract || j.type === 'disambiguation') return null;
  const page = (j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page) || `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  return { title: `${title} - Wikipedia`, url: page, snippet: j.description || '', text: j.extract, site: 'Wikipedia', image: (j.thumbnail && j.thumbnail.source) || null };
}

// ── reading a page ──────────────────────────────────────────────────────────

/** The readable part of a page: title, site name, description and its main text. */
function readable(html, max = 3500) {
  const title = text((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1]);
  const meta = (name) => { const m = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i').exec(html) || new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, 'i').exec(html); return m ? decode(m[1]).trim() : ''; };
  let body = html.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|form|button|select)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  const main = /<(article|main)\b[\s\S]*?<\/\1>/i.exec(body);
  if (main && text(main[0]).length > 400) body = main[0];
  // keep paragraphs, list items, headings and table cells; they hold the facts
  const parts = [];
  const re = /<(p|li|h[1-4]|td|th|dd|blockquote|pre)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(body))) {
    const t = text(m[2]);
    if (t.length >= (m[1][0] === 'h' ? 3 : 30) && !/cookie|subscribe|sign up for|newsletter|all rights reserved|javascript/i.test(t)) parts.push(m[1][0] === 'h' ? `## ${t}` : m[1] === 'li' ? `- ${t}` : t);
  }
  let out = parts.join('\n');
  if (out.length < 80) out = text(body); // no paragraphs to speak of: take all its words
  if (out.length > max) out = out.slice(0, max).replace(/\s+\S*$/, '') + ' …';
  return { title, site: meta('og:site_name'), description: meta('description') || meta('og:description'), image: meta('og:image') || null, text: out };
}

async function read(source, { signal, timeout = 4500 } = {}) {
  if (source.text) return source;
  try {
    const r = await get(source.url, { signal, timeout });
    if (!r.ok || !/html|text\/plain/i.test(r.type)) return { ...source, failed: true };
    const p = /html/i.test(r.type) ? readable(r.body) : { text: r.body.slice(0, 3500) };
    if (!p.text || p.text.length < 80) return { ...source, failed: true };
    return { ...source, title: source.title || p.title, site: p.site || source.site || '', description: p.description, image: source.image || p.image, text: p.text };
  } catch { return { ...source, failed: true }; }
}

/**
 * The whole look-up. onStep({ step: 'search'|'read'|'done', count }) for progress.
 * Resolves with [{ n, title, url, domain, site, snippet, text, image }]: the
 * sources, numbered from 1, that were actually read (or at least had a snippet).
 */
async function lookUp(q, { braveKey = '', signal, pages = 5, onStep = () => {} } = {}) {
  onStep({ step: 'search' });
  const [web, wiki] = await Promise.all([
    (async () => {
      if (braveKey) { try { return await brave(q, braveKey, { signal }); } catch { /* try DuckDuckGo */ } }
      try { return await duck(q, { signal }); } catch { return []; }
    })(),
    wikipedia(q, { signal }).catch(() => null),
  ]);
  // one result per website, best first; Wikipedia goes in once
  const seen = new Set();
  const picks = [];
  for (const r of web) {
    const d = domainOf(r.url);
    if (!d || seen.has(d) || /youtube\.com|tiktok\.com|instagram\.com|facebook\.com|pinterest\./.test(d)) continue;
    seen.add(d);
    picks.push(r);
    if (picks.length >= pages) break;
  }
  if (wiki && !seen.has('en.wikipedia.org')) picks.splice(Math.min(2, picks.length), 0, wiki);
  onStep({ step: 'read', count: picks.length });
  const read_ = await Promise.all(picks.map((s) => read(s, { signal })));
  const good = read_.filter((s) => !s.failed || s.snippet);
  onStep({ step: 'done', count: good.length });
  return good.slice(0, pages + 1).map((s, i) => ({ n: i + 1, title: s.title || domainOf(s.url), url: s.url, domain: domainOf(s.url), site: s.site || '', snippet: s.snippet || s.description || '', text: s.failed ? '' : s.text, image: s.image || null }));
}

module.exports = { lookUp, parseDuck, readable, decode, domainOf, wikipedia, duck, brave, read };
