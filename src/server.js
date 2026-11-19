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
const history = {
  load: () => readJson(path.join(home(), 'history.json'), []),
  add(item) {
    const all = [item, ...history.load().filter((x) => x.id !== item.id)].slice(0, 100);
    fs.mkdirSync(home(), { recursive: true });
    fs.writeFileSync(path.join(home(), 'history.json'), JSON.stringify(all));
  },
  clear() { try { fs.unlinkSync(path.join(home(), 'history.json')); } catch { /* already gone */ } },
};

function body(req, max = 1e6) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > max) { reject(new Error('too big')); req.destroy(); } });
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
    models: all.map((m) => ({ key: AI.keyOf(m), name: m.name, provider: m.provider, free: !!m.free, local: AI.local(m) })),
    free: Object.entries(AI.FREE).map(([id, f]) => ({ id, name: f.name, url: f.url, steps: f.steps })),
    brave: !!c.braveKey,
    recent: history.load().slice(0, 30).map((h) => ({ id: h.id, q: h.q, at: h.at })),
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
      if (rest.startsWith('/api/past/') && req.method === 'GET') {
        const h = history.load().find((x) => x.id === rest.slice(10));
        return h ? send(200, h) : send(404, { error: 'That one was cleared.' });
      }
      if (rest === '/api/forget' && req.method === 'POST') { history.clear(); return send(200, { ok: true }); }
      if (rest === '/api/key' && req.method === 'POST') {
        const b = await body(req);
        const m = await AI.addKey(b.provider, b.key);
        config.save({ ...config.load(), model: AI.keyOf(m) });
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

/** One question, streamed back as server-sent events. */
async function ask(req, res, b) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const q = String(b.q || '').trim().slice(0, 2000);
  if (!q) { ev('error', { message: 'Type a question first.' }); return res.end(); }
  const c = config.load();
  const { model } = await AI.current(c.model);
  let sources = [];
  try {
    const r = await answer(q, {
      history: (Array.isArray(b.history) ? b.history : []).slice(-2).map((h) => ({ q: String(h.q || ''), a: String(h.a || '') })),
      braveKey: c.braveKey || '', model, signal: ac.signal,
      onStep: (s) => ev('step', s),
      onSources: (s) => { sources = s; ev('sources', s.map(({ text, ...rest }) => rest)); },
      onText: (t) => ev('text', t),
    });
    const id = crypto.randomBytes(6).toString('hex');
    history.add({ id, q, a: r.text, followups: r.followups, sources: r.sources.map(({ text, ...rest }) => rest), model: r.model && r.model.name, at: Date.now() });
    ev('done', { id, followups: r.followups, model: r.model && r.model.name });
  } catch (e) {
    if (e.message === 'NO_AI') ev('noai', { sources: (e.sources || sources).map(({ text, ...rest }) => rest) });
    else if (e.name !== 'AbortError') ev('error', { message: friendly(e) });
  }
  res.end();
}

function friendly(e) {
  const s = Number(e.status) || 0;
  if (s === 401 || s === 403) return 'The AI service turned down your key. Open Settings (the gear) and paste a fresh free key.';
  if (s === 429) return 'The free AI is busy right now (too many questions in a short time). Wait a minute and ask again, or add another free AI in Settings.';
  return e.message || String(e);
}

module.exports = { serve, config, history, home, state };
