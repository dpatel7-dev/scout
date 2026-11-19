'use strict';
// scout's page, served from this computer. It listens only on 127.0.0.1, at an
// address with a secret in it, so nothing else on the network can use it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const AI = require('./ai');
const { answer } = require('./answer');
const pkg = require('../package.json');

const PAGE = path.join(__dirname, '..', 'web', 'scout.html');
const home = () => process.env.SCOUT_HOME || path.join(os.homedir(), '.scout');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const config = {
  load: () => readJson(path.join(home(), 'config.json'), {}),
  save(c) { fs.mkdirSync(home(), { recursive: true }); fs.writeFileSync(path.join(home(), 'config.json'), JSON.stringify(c, null, 2), { mode: 0o600 }); },
};

// ── your chats, kept on this computer ──
const KINDS = new Set(['text', 'markdown', 'code', 'json', 'table']);
const chats = {
  file: () => path.join(home(), 'chats.json'),
  load() {
    const all = readJson(chats.file(), null);
    if (all) return all;
    // scout 1.0 kept single questions: each becomes a chat of its own
    return readJson(path.join(home(), 'history.json'), []).map((h) => ({ id: h.id, title: h.q, at: h.at, turns: [{ q: h.q, a: h.a, sources: h.sources || [], followups: h.followups || [], model: h.model, at: h.at }] }));
  },
  save(all) {
    fs.mkdirSync(home(), { recursive: true });
    fs.writeFileSync(chats.file(), JSON.stringify(all.slice(0, 60)));
  },
  get: (id) => chats.load().find((c) => c.id === id) || null,
  put(chat) { chats.save([chat, ...chats.load().filter((c) => c.id !== chat.id)]); },
  remove(id) { chats.save(chats.load().filter((c) => c.id !== id)); },
  clear() { for (const f of ['chats.json', 'history.json']) { try { fs.unlinkSync(path.join(home(), f)); } catch { /* already gone */ } } },
};

/** What was pasted, checked: at most 5 pieces, each a known kind and not enormous. */
function cleanPasted(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 5).filter((p) => p && typeof p.text === 'string' && p.text.trim()).map((p) => ({
    kind: KINDS.has(p.kind) ? p.kind : 'text',
    lang: typeof p.lang === 'string' ? p.lang.slice(0, 20) : '',
    name: typeof p.name === 'string' ? p.name.slice(0, 120) : '',
    text: p.text.slice(0, 200000),
  }));
}

function body(req, max = 1.5e6) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > max) { reject(new Error('That is too much to send at once.')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('bad request')); } });
    req.on('error', reject);
  });
}

async function state() {
  const c = config.load();
  const { model, all } = await AI.current(c.model);
  return {
    version: pkg.version,
    model: model ? { key: AI.keyOf(model), name: model.name, provider: model.provider, local: AI.local(model) } : null,
    picked: c.model || '',
    models: all.map((m) => ({ key: AI.keyOf(m), name: m.name, provider: m.provider, free: !!m.free, local: AI.local(m) })),
    free: Object.entries(AI.FREE).map(([id, f]) => ({ id, name: f.name, url: f.url, steps: f.steps })),
    brave: !!c.braveKey,
    chats: chats.load().slice(0, 40).map((h) => ({ id: h.id, title: h.title, at: h.at })),
  };
}

/** Start it. Resolves with { url, port, close }. */
function serve({ port = 0, token = crypto.randomBytes(16).toString('base64url') } = {}) {
  const base = `/${token}`;
  const server = http.createServer(async (req, res) => {
    const send = (code, obj, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
    };
    try {
      const host = req.headers.host || '';
      const p = server.address().port;
      if (host !== `127.0.0.1:${p}` && host !== `localhost:${p}`) return send(403, { error: 'not here' });
      const u = new URL(req.url, `http://${host}`);
      if (!u.pathname.startsWith(base)) return send(404, 'not here\n', 'text/plain');
      const rest = u.pathname.slice(base.length) || '/';
      if (rest === '/' && req.method === 'GET') {
        const html = fs.readFileSync(PAGE, 'utf8').replace('/*SCOUT*/{}', () => JSON.stringify({ base: base + '/', version: pkg.version }).replace(/</g, '\\u003c'));
        return send(200, html, 'text/html; charset=utf-8');
      }
      if (rest === '/api/state' && req.method === 'GET') return send(200, await state());
      let m = /^\/api\/chat\/([\w-]+)$/.exec(rest);
      if (m && req.method === 'GET') { const c = chats.get(m[1]); return c ? send(200, c) : send(404, { error: 'That chat was deleted.' }); }
      m = /^\/api\/chat\/([\w-]+)\/delete$/.exec(rest);
      if (m && req.method === 'POST') { chats.remove(m[1]); return send(200, await state()); }
      if (rest === '/api/forget' && req.method === 'POST') { chats.clear(); return send(200, await state()); }
      if (rest === '/api/key' && req.method === 'POST') {
        const b = await body(req);
        const added = await AI.addKey(b.provider, b.key);
        config.save({ ...config.load(), model: AI.keyOf(added) });
        return send(200, await state());
      }
      if (rest === '/api/model' && req.method === 'POST') { const b = await body(req); config.save({ ...config.load(), model: b.model || undefined }); return send(200, await state()); }
      if (rest === '/api/brave' && req.method === 'POST') { const b = await body(req); config.save({ ...config.load(), braveKey: String(b.key || '').trim() || undefined }); return send(200, await state()); }
      if (rest === '/api/ask' && req.method === 'POST') return ask(req, res, await body(req));
      return send(404, { error: 'not here' });
    } catch (e) {
      if (!res.headersSent) send(500, { error: e.message });
      else res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      resolve({ url: `http://127.0.0.1:${p}${base}/`, port: p, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/** One message in a chat, answered as server-sent events. */
async function ask(req, res, b) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const q = String(b.q || '').trim().slice(0, 8000);
  const pasted = cleanPasted(b.pasted);
  if (!q && !pasted.length) { ev('error', { message: 'Type a question, or paste something.' }); return res.end(); }
  const c = config.load();
  const { model } = await AI.current(c.model);
  const chat = (b.chat && chats.get(String(b.chat))) || { id: crypto.randomBytes(6).toString('hex'), title: '', at: Date.now(), turns: [] };
  if (b.retry && chat.turns.length) chat.turns.pop(); // "try again" replaces the last answer
  ev('chat', { id: chat.id });
  let sources = [];
  try {
    const r = await answer(q, {
      history: chat.turns, pasted, search: b.search !== false, deep: !!b.deep,
      braveKey: c.braveKey || '', model, signal: ac.signal,
      onStep: (s) => ev('step', s),
      onSources: (s) => { sources = s; ev('sources', s.map(({ text, ...rest }) => rest)); },
      onText: (t) => ev('text', t),
    });
    const at = Date.now();
    chat.turns.push({ q, pasted: pasted.map((p) => ({ ...p, text: p.text.slice(0, 20000) })), a: r.text, followups: r.followups, sources: r.sources.map(({ text, ...rest }) => rest), model: r.model && r.model.name, at });
    chat.turns = chat.turns.slice(-40);
    if (!chat.title) chat.title = (q || (pasted[0] && (pasted[0].name || `Pasted ${pasted[0].kind === 'json' ? 'JSON' : pasted[0].kind}`)) || 'New chat').replace(/\s+/g, ' ').slice(0, 80);
    chat.at = at;
    chats.put(chat);
    ev('done', { id: chat.id, followups: r.followups, model: r.model && r.model.name, searched: r.searched });
  } catch (e) {
    if (e.message === 'NO_AI') ev('noai', { sources: (e.sources || sources).map(({ text, ...rest }) => rest) });
    else if (e.name !== 'AbortError') ev('error', { message: friendly(e) });
  }
  res.end();
}

function friendly(e) {
  const s = Number(e.status) || 0;
  if (s === 401 || s === 403) return 'The AI service turned down your key. Open Settings (the gear) and paste a fresh free key.';
  if (s === 429) return 'The free AI is busy right now (too many questions in a short time). Wait a minute and try again, or add another free AI in Settings.';
  if (s === 413 || /too (long|large)|context length|maximum context/i.test(e.message)) return 'That was too much for this AI to read at once. Paste a smaller part, or pick a different AI with the button under the box.';
  return e.message || String(e);
}

module.exports = { serve, config, chats, home, state, cleanPasted };
