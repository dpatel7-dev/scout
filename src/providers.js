'use strict';
// Talking to AI services. Most speak the same "OpenAI-style" language, so one
// client covers OpenRouter, OpenAI, Google, Groq, Hugging Face and Ollama;
// Anthropic gets its own. Answers stream in as they're written.

const PROVIDERS = {
  openrouter: {
    name: 'OpenRouter', kind: 'openai', base: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys', about: 'one key for hundreds of models (Claude, GPT, Gemini, Grok, DeepSeek, Llama…)',
  },
  openai: { name: 'OpenAI', kind: 'openai', base: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys', about: 'GPT models' },
  anthropic: { name: 'Anthropic', kind: 'anthropic', base: 'https://api.anthropic.com/v1', keyUrl: 'https://console.anthropic.com/settings/keys', about: 'Claude models' },
  google: {
    name: 'Google AI Studio', kind: 'openai', base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/apikey', about: 'Gemini models (has a free tier)',
  },
  groq: { name: 'Groq', kind: 'openai', base: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys', about: 'very fast open models (has a free tier)' },
  huggingface: {
    name: 'Hugging Face', kind: 'openai', base: 'https://router.huggingface.co/v1',
    keyUrl: 'https://huggingface.co/settings/tokens', about: 'open models, with free monthly credits',
  },
  mistral: { name: 'Mistral', kind: 'openai', base: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys', about: 'Mistral models' },
  cerebras: { name: 'Cerebras', kind: 'openai', base: 'https://api.cerebras.ai/v1', keyUrl: 'https://cloud.cerebras.ai', about: 'very fast open models' },
  nvidia: { name: 'NVIDIA', kind: 'openai', base: 'https://integrate.api.nvidia.com/v1', keyUrl: 'https://build.nvidia.com/settings/api-keys', about: '100+ big open models (DeepSeek, Kimi, Qwen…), free at 40 a minute' },
  ollamacloud: { name: 'Ollama Cloud', kind: 'openai', base: 'https://ollama.com/v1', keyUrl: 'https://ollama.com/settings/keys', about: "big open models on Ollama's computers (free light use)" },
  sambanova: { name: 'SambaNova', kind: 'openai', base: 'https://api.sambanova.ai/v1', keyUrl: 'https://cloud.sambanova.ai/apis', about: 'fast big open models (a few free questions a day)' },
  ollama: { name: 'Ollama', kind: 'openai', base: 'http://127.0.0.1:11434/v1', noKey: true, keyUrl: 'https://ollama.com/download', about: 'models running on this computer: free, private, and no internet needed' },
  custom: { name: 'Other service', kind: 'openai', base: '', custom: true, keyUrl: '', about: 'any OpenAI-compatible address (set it in the dashboard, or TOT_URL_CUSTOM)' },
  // not a service: "Auto (free)" picks one of your free models for each question (see answer.js)
  auto: { name: 'Tree of Thought', kind: 'auto', base: '', noKey: true, hidden: true, keyUrl: '', about: 'picks the best free model with room left' },
};
let customBase = '';
/** Where the "Other service" lives (from your settings). */
function setCustomBase(url) { customBase = /^https?:\/\/\S+$/.test(String(url || '')) ? String(url) : ''; }
const IDS = Object.keys(PROVIDERS).filter((id) => !PROVIDERS[id].hidden);

/** The rate-limit headers a service sent back (how much is left), if any. */
function limitHeaders(res) {
  const out = {};
  if (!res || !res.headers) return out;
  for (const [k, v] of res.headers) if (/^(x-ratelimit-|retry-after$)/i.test(k)) out[k.toLowerCase()] = v;
  return out;
}

/** Where a provider lives (tests and custom setups can point it elsewhere). */
function baseOf(id) {
  return (process.env[`TOT_URL_${id.toUpperCase()}`] || (id === 'custom' ? customBase : '') || PROVIDERS[id].base).replace(/\/+$/, '');
}

function headers(id, key) {
  const p = PROVIDERS[id];
  const h = { 'content-type': 'application/json' };
  if (p.kind === 'anthropic') {
    h['x-api-key'] = key;
    h['anthropic-version'] = '2023-06-01';
  } else if (key) h.authorization = `Bearer ${key}`;
  if (id === 'openrouter') {
    h['http-referer'] = 'https://github.com/dpatel7-dev/Tree-Of-Thought';
    h['x-title'] = 'Tree of Thought';
  }
  return h;
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Turn an error response into one sentence a person can act on. */
async function failure(id, res) {
  let detail = '';
  try {
    const body = await res.text();
    try {
      const j = JSON.parse(body);
      detail = (j.error && (j.error.message || j.error)) || j.message || body;
    } catch { detail = body; }
  } catch { /* nothing to read */ }
  detail = String(detail || '').replace(/\s+/g, ' ').slice(0, 240);
  const name = PROVIDERS[id].name;
  if (res.status === 401 || res.status === 403) return new ApiError(`${name} didn't accept your key. Check it, then set it again with /key ${id} <your key>. (${detail || res.status})`, res.status);
  if (res.status === 402) return new ApiError(`${name} says your account is out of credit. (${detail})`, res.status);
  if (res.status === 404) return new ApiError(`${name} doesn't know that model. (${detail || 'not found'})`, res.status);
  if (res.status === 429) return Object.assign(new ApiError(`${name} says slow down (too many requests, or a free limit was reached). Try again in a moment. (${detail})`, res.status), { headers: limitHeaders(res), detail });
  return Object.assign(new ApiError(`${name} answered with an error ${res.status}: ${detail || res.statusText}`, res.status), { headers: limitHeaders(res), detail });
}

function friendlyNetwork(id, e) {
  if (e && e.name === 'AbortError') return e;
  const name = PROVIDERS[id].name;
  if (id === 'ollama') return new ApiError("Couldn't reach Ollama on this computer. Is it running? (Get it from ollama.com, then try again.)");
  const cause = (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || e;
  return new ApiError(`Couldn't reach ${name}: ${cause}. Check your internet connection.`);
}

// ── model lists ─────────────────────────────────────────────────────────────

/** Every model a provider offers: [{ provider, id, name, created, price: {in, out} (per million tokens), context }]. */
async function listModels(id, key, { signal } = {}) {
  let res;
  try {
    res = await fetch(baseOf(id) + '/models', { headers: headers(id, key), signal });
  } catch (e) { throw friendlyNetwork(id, e); }
  if (!res.ok) throw await failure(id, res);
  const body = await res.json();
  const list = Array.isArray(body) ? body : Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  return list.map((m) => normalize(id, m)).filter((m) => m && m.id);
}

function normalize(provider, m) {
  if (!m || typeof m !== 'object') return null;
  const id = String(m.id || m.name || '').replace(/^models\//, '');
  if (!id) return null;
  let name = String(m.name && m.name !== m.id ? m.name : m.display_name || id);
  name = name.replace(/^[^:]{1,30}:\s+/, ''); // "Anthropic: Claude …" -> "Claude …"
  const created = Number(m.created) ? Number(m.created) * (Number(m.created) < 1e12 ? 1000 : 1) : m.created_at ? Date.parse(m.created_at) || 0 : 0;
  const per = (v) => (v === undefined || v === null || v === '' ? null : Number(v) * 1e6);
  const price = m.pricing ? { in: per(m.pricing.prompt), out: per(m.pricing.completion) } : null;
  const outputs = m.architecture && (m.architecture.output_modalities || (m.architecture.modality ? [String(m.architecture.modality).split('->')[1]] : null));
  return {
    provider, id, name: name.slice(0, 60), created, price,
    context: Number(m.context_length || m.context_window) || null,
    text: !outputs || outputs.some((o) => /text/.test(String(o))),
    free: /:free$/.test(id) || (price && price.in === 0 && price.out === 0),
  };
}

const AUTHORS = ['anthropic', 'openai', 'google', 'x-ai', 'deepseek', 'meta-llama', 'mistralai', 'qwen', 'moonshotai', 'z-ai'];

/**
 * A starting garden from a big list: for each well-known maker, its strongest
 * recent model (newest few months, then the priciest - usually the flagship).
 */
function pickGarden(models, { free = false, max = 8 } = {}) {
  const usable = models.filter((m) => m.text && !/batch|image|audio|embed|tts|whisper|moderation|guard|vision-preview/i.test(m.id) && (!free || m.free) && (free || !/:free$/.test(m.id)));
  const out = [];
  for (const author of AUTHORS) {
    const mine = usable.filter((m) => m.id.startsWith(author + '/'));
    if (!mine.length) continue;
    const newest = Math.max(...mine.map((m) => m.created || 0));
    const recent = mine.filter((m) => !newest || (m.created || 0) >= newest - 120 * 86400000);
    recent.sort((a, b) => ((b.price && b.price.out) || 0) - ((a.price && a.price.out) || 0) || (b.created || 0) - (a.created || 0));
    out.push(recent[0]);
    if (out.length >= max) break;
  }
  if (!out.length) return usable.slice(0, max);
  return out;
}

// ── chatting ────────────────────────────────────────────────────────────────

/**
 * Ask a model. `messages` is [{ role: 'user'|'assistant', content }]. Calls
 * onText(piece) / onThought(piece) as the answer streams in, and resolves with
 * { text, thought, usage }. Pass an AbortSignal to stop early.
 */
async function chat({ provider, key, model, messages, system, signal, onText = () => {}, onThought = () => {} }) {
  const p = PROVIDERS[provider];
  if (!p) throw new ApiError(`Unknown provider "${provider}".`);
  if (p.kind === 'auto') throw new ApiError('Auto picks a model for you: ask through answer.js, not providers.chat.');
  if (!p.noKey && !key) throw new ApiError(`There's no key for ${p.name} yet. Get one at ${p.keyUrl} and add it with /key ${provider} <your key>.`);
  const body = p.kind === 'anthropic'
    ? { model, max_tokens: 8192, stream: true, messages, ...(system ? { system } : {}) }
    : { model, stream: true, messages: system ? [{ role: 'system', content: system }, ...messages] : messages, ...(provider === 'openrouter' ? { usage: { include: true } } : {}) };
  let res;
  try {
    res = await fetch(baseOf(provider) + (p.kind === 'anthropic' ? '/messages' : '/chat/completions'), {
      method: 'POST', headers: headers(provider, key), body: JSON.stringify(body), signal,
    });
  } catch (e) { throw friendlyNetwork(provider, e); }
  if (!res.ok) throw await failure(provider, res);

  const out = { text: '', thought: '', usage: null, headers: limitHeaders(res) };
  const take = p.kind === 'anthropic' ? anthropicEvent : openaiEvent;
  try {
    for await (const data of sse(res.body)) {
      if (data === '[DONE]') break;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      take(ev, out, onText, onThought, p.name);
    }
  } catch (e) {
    if (e.name === 'AbortError' || (signal && signal.aborted)) { const a = new Error('stopped'); a.name = 'AbortError'; throw a; }
    throw e instanceof ApiError ? e : new ApiError(`The answer was cut off: ${e.message}`);
  }
  return out;
}

function openaiEvent(ev, out, onText, onThought, name) {
  if (ev.error) throw new ApiError(`${name}: ${ev.error.message || JSON.stringify(ev.error)}`);
  if (ev.usage) out.usage = { in: ev.usage.prompt_tokens, out: ev.usage.completion_tokens, cost: ev.usage.cost };
  const d = ev.choices && ev.choices[0] && ev.choices[0].delta;
  if (!d) return;
  const thought = d.reasoning || d.reasoning_content;
  if (typeof thought === 'string' && thought) { out.thought += thought; onThought(thought); }
  if (typeof d.content === 'string' && d.content) { out.text += d.content; onText(d.content); }
}

function anthropicEvent(ev, out, onText, onThought, name) {
  if (ev.type === 'error') throw new ApiError(`${name}: ${(ev.error && ev.error.message) || 'error'}`);
  if (ev.type === 'message_start' && ev.message && ev.message.usage) out.usage = { in: ev.message.usage.input_tokens, out: 0 };
  if (ev.type === 'message_delta' && ev.usage) out.usage = { ...(out.usage || {}), out: ev.usage.output_tokens };
  if (ev.type !== 'content_block_delta' || !ev.delta) return;
  if (ev.delta.type === 'text_delta') { out.text += ev.delta.text; onText(ev.delta.text); }
  if (ev.delta.type === 'thinking_delta') { out.thought += ev.delta.thinking; onThought(ev.delta.thinking); }
}

/** Server-sent events: yields each event's data. */
async function* sse(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (data) yield data;
    }
  }
  const rest = buf.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
  if (rest) yield rest;
}

// ── what this network lets through ──────────────────────────────────────────

/**
 * Can this computer reach each service (and the page where you get its key)?
 * Some networks - schools, offices - block some of them. Resolves with
 * [{ id, name, api: 'ok'|'blocked'|'inspected'|'slow'|'off', site: …, ms, why }].
 */
async function checkNetwork({ timeout = 7000 } = {}) {
  const probe = async (url) => {
    const t0 = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, { method: 'GET', signal: ac.signal, redirect: 'manual' });
      const type = res.headers.get('content-type') || '';
      let body = '';
      if (/html/.test(type)) { try { body = (await res.text()).slice(0, 4000); } catch { /* fine */ } }
      // filters often answer with their own "this site is blocked" page
      if (/blocked|filtered|restricted|not allowed|access denied|lightspeed|securly|goguardian|fortiguard|contentkeeper|iboss|websense|zscaler/i.test(body) && !/openrouter|openai|anthropic|google|groq|hugging|mistral|cerebras/i.test(res.url || '')) return { state: 'blocked', ms: Date.now() - t0, why: 'a filter answered instead' };
      return { state: Date.now() - t0 > 4000 ? 'slow' : 'ok', ms: Date.now() - t0, why: String(res.status) };
    } catch (e) {
      const code = (e.cause && (e.cause.code || e.cause.message)) || e.name || String(e);
      if (e.name === 'AbortError') return { state: 'blocked', ms: Date.now() - t0, why: 'no answer (timed out)' };
      if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|certificate/i.test(code)) return { state: 'inspected', ms: Date.now() - t0, why: 'this network replaces secure certificates' };
      if (/ECONNREFUSED/.test(code)) return { state: 'off', ms: Date.now() - t0, why: 'nothing is listening' };
      return { state: 'blocked', ms: Date.now() - t0, why: code };
    } finally { clearTimeout(timer); }
  };
  const ids = IDS.filter((id) => id !== 'custom' || customBase);
  return Promise.all(ids.map(async (id) => {
    const p = PROVIDERS[id];
    const [api, site] = await Promise.all([probe(baseOf(id) + '/models'), p.keyUrl && !p.noKey ? probe(p.keyUrl) : Promise.resolve(null)]);
    return { id, name: p.name, api: api.state, site: site ? site.state : null, ms: api.ms, why: api.why };
  }));
}

// ── Ollama: models that run on this computer ───────────────────────────────

const ollamaRoot = () => baseOf('ollama').replace(/\/v1$/, '');

/** What's downloaded: [{ name, size, family }], or null if Ollama isn't running. */
async function ollamaModels() {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    const res = await fetch(ollamaRoot() + '/api/tags', { signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json();
    return (j.models || []).map((m) => ({ name: m.name, size: m.size || 0, family: (m.details && m.details.family) || '' }));
  } catch { return null; }
}

/** Download a model into Ollama. onProgress({ status, done, total }). */
async function ollamaPull(name, { onProgress = () => {}, signal } = {}) {
  let res;
  try {
    res = await fetch(ollamaRoot() + '/api/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: name, stream: true }), signal });
  } catch (e) { throw friendlyNetwork('ollama', e); }
  if (!res.ok) throw new ApiError(`Ollama couldn't download "${name}" (${res.status}). Check the name on ollama.com/library.`, res.status);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.error) throw new ApiError(`Ollama: ${j.error}`);
      onProgress({ status: j.status || '', done: j.completed || 0, total: j.total || 0 });
    }
  }
}

async function ollamaDelete(name) {
  const res = await fetch(ollamaRoot() + '/api/delete', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: name }) });
  if (!res.ok) throw new ApiError(`Ollama couldn't remove "${name}" (${res.status}).`, res.status);
}

/** Is Ollama running here? (A free garden with no keys at all.) */
async function ollamaHere() {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 600);
    const list = await listModels('ollama', null, { signal: ac.signal });
    clearTimeout(t);
    return list;
  } catch { return null; }
}

module.exports = { limitHeaders, PROVIDERS, IDS, baseOf, listModels, pickGarden, chat, sse, ollamaHere, ApiError, normalize, setCustomBase, checkNetwork, ollamaModels, ollamaPull, ollamaDelete };
