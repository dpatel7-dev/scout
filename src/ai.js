'use strict';
// The AI that writes scout's answers. scout borrows Tree of Thought's AI
// setup (~/.tot), so if you already use Tree of Thought, tidy or den there's
// nothing new to set up. If you don't, scout's page has a "Set up free AI"
// box: paste a free key from Groq or Google and you're done.

const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./providers');

const totHome = () => process.env.TOT_HOME || path.join(os.homedir(), '.tot');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const keyOf = (m) => `${m.provider}:${m.id}`;
const local = (m) => m && m.provider === 'ollama';

/** Free AI services you can set up from scout's page, and the model each one plants. */
const FREE = {
  groq: { name: 'Groq', url: 'https://console.groq.com/keys', model: { provider: 'groq', id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', free: true, power: 7, fast: true }, steps: 'Sign in with Google, click "Create API Key", then Copy.' },
  google: { name: 'Google Gemini', url: 'https://aistudio.google.com/apikey', model: { provider: 'google', id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', free: true, power: 8 }, steps: 'Sign in with Google, click "Create API key", then Copy.' },
  openrouter: { name: 'OpenRouter', url: 'https://openrouter.ai/keys', model: { provider: 'openrouter', id: 'deepseek/deepseek-chat-v3-0324:free', name: 'DeepSeek V3 (free)', free: true, power: 8 }, steps: 'Sign in, click "Create Key", then Copy.' },
};

async function models() {
  const out = [];
  const tot = readJson(path.join(totHome(), 'config.json'), {});
  if (tot.customBase) P.setCustomBase(tot.customBase);
  const keys = readJson(path.join(totHome(), 'keys.json'), {});
  for (const m of tot.garden || []) {
    if (m.provider === 'auto' || out.some((x) => keyOf(x) === keyOf(m))) continue;
    if (!P.PROVIDERS[m.provider]) continue;
    if (!P.PROVIDERS[m.provider].noKey && !keys[m.provider]) continue;
    out.push({ provider: m.provider, id: m.id, name: m.name || m.id, free: !!m.free, power: m.power || 0 });
  }
  const mine = await P.ollamaModels().catch(() => null);
  for (const m of mine || []) {
    if (/embed/i.test(m.name) || out.some((x) => x.provider === 'ollama' && x.id === m.name)) continue;
    out.push({ provider: 'ollama', id: m.name, name: m.name, size: m.size || 0 });
  }
  return out;
}

/**
 * The model to ask: the one you picked; else a fast free one (answers should
 * pop out quickly: Groq first), else the strongest free one, else this
 * computer's, else Tree of Thought's current one.
 */
async function current(choice = null) {
  const all = await models();
  const picked = choice && all.find((m) => keyOf(m) === choice);
  if (picked) return { model: picked, all };
  const free = all.filter((m) => m.free && !local(m));
  const fast = free.find((m) => m.provider === 'groq' || m.provider === 'cerebras');
  if (fast) return { model: fast, all };
  if (free.length) return { model: free.sort((a, b) => (b.power || 0) - (a.power || 0))[0], all };
  const locals = all.filter(local).sort((a, b) => (b.size || 0) - (a.size || 0));
  if (locals.length) return { model: locals[0], all };
  const tot = readJson(path.join(totHome(), 'config.json'), {});
  const g = (tot.garden || [])[tot.current || 0];
  return { model: (g && all.find((m) => keyOf(m) === keyOf(g))) || all[0] || null, all };
}

/** Save a free key (shared with Tree of Thought) and plant its model. */
async function addKey(provider, key, { check = true } = {}) {
  const f = FREE[provider];
  if (!f) throw new Error('Pick Groq, Google Gemini or OpenRouter.');
  key = String(key || '').trim();
  if (key.length < 12 || /\s/.test(key)) throw new Error("That doesn't look like a key. Copy the whole thing and paste it again.");
  if (check) {
    try { await P.chat({ provider, key, model: f.model.id, messages: [{ role: 'user', content: 'Say OK.' }] }); } catch (e) {
      const s = Number(e.status) || 0;
      if (s === 401 || s === 403) throw new Error(`${f.name} didn't accept that key. Copy it again (all of it) and paste it here.`);
      if (s && s !== 429) throw new Error(`${f.name} said: ${e.message}`);
      if (!s && !/model|rate|limit/i.test(e.message)) throw new Error(`Couldn't reach ${f.name}: ${e.message}`);
    }
  }
  fs.mkdirSync(totHome(), { recursive: true });
  const keysFile = path.join(totHome(), 'keys.json');
  const keys = readJson(keysFile, {});
  keys[provider] = key;
  fs.writeFileSync(keysFile, JSON.stringify(keys, null, 2), { mode: 0o600 });
  const cfgFile = path.join(totHome(), 'config.json');
  const cfg = readJson(cfgFile, {});
  cfg.garden = Array.isArray(cfg.garden) ? cfg.garden : [];
  if (!cfg.garden.some((m) => keyOf(m) === keyOf(f.model))) cfg.garden.push({ ...f.model });
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  return f.model;
}

/** Stream an answer: onText(piece) as it's written. Busy free models hand over to another free one. */
async function stream({ model, system, messages, onText = () => {}, signal }) {
  const keys = readJson(path.join(totHome(), 'keys.json'), {});
  const all = model.free ? await models() : [];
  const others = all.filter((m) => m.free && !local(m) && keyOf(m) !== keyOf(model)).sort((a, b) => (b.power || 0) - (a.power || 0));
  let last;
  let said = false;
  for (const m of [model, ...others].slice(0, 4)) {
    try {
      const r = await P.chat({ provider: m.provider, key: keys[m.provider], model: m.id, system, messages, signal, onText: (t) => { said = true; onText(t); } });
      return { text: r.text, model: m };
    } catch (e) {
      last = e;
      const s = Number(e.status) || 0;
      if (said || e.name === 'AbortError' || !(s === 429 || s >= 500 || (!s && /couldn't reach|cut off/i.test(e.message)))) throw e;
    }
  }
  throw last;
}

module.exports = { models, current, addKey, stream, keyOf, local, totHome, FREE };
