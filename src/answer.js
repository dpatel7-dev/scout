'use strict';
// Turning what scout read into an answer: short, clear, and every fact
// pointing at the page it came from.

const AI = require('./ai');
const Search = require('./search');

function system(today) {
  return `You are Pip, a friendly owl inside scout, an app that looks things up on the web and explains what it found. Today is ${today}.
Many people who use scout read slowly or are new to a topic. Write so anyone can follow:
- Start with the answer itself in one or two plain sentences, in **bold**. No greeting, no "Great question".
- Then the useful details: short bullet points or a few short paragraphs. Use a small table only when comparing things. Use headings (##) only for long answers.
- Use everyday words and short sentences. Explain any hard word the first time.
- Use only the sources you're given for facts. After each fact, cite its source number in square brackets, like [1] or [2][4]. Never invent a source or a number.
- If the sources disagree, say so. If they don't answer the question, say what they do say, and that you couldn't find the rest.
- Keep it short: most answers fit in 150 words. Longer only if the question really needs it.
- On the very last line, write: FOLLOWUPS: then three short follow-up questions the person might ask next, separated by " | ".`;
}

function sourcesBlock(sources) {
  return sources.map((s) => `[${s.n}] ${s.title} (${s.domain})\n${(s.text || s.snippet || '').slice(0, 3500)}`).join('\n\n');
}

/** Split the answer from the follow-up questions at its end. */
function splitFollowups(full) {
  const m = /\n?\s*\**FOLLOW-?UPS?\**:?\**\s*(.*)$/is.exec(full);
  if (!m) return { text: full.trim(), followups: [] };
  const followups = m[1].split(/\s*\|\s*|\n+/).map((x) => x.replace(/^[-*\d.\s]+/, '').trim()).filter((x) => x.length > 3).slice(0, 3);
  return { text: full.slice(0, m.index).trim(), followups };
}

/** Which source numbers an answer actually cites. */
function cited(text) { const out = new Set(); for (const m of String(text).matchAll(/\[(\d+)\]/g)) out.add(Number(m[1])); return out; }

/**
 * Look it up and answer. Calls:
 *   onStep({ step, count })      searching / reading / writing
 *   onSources(sources)           as soon as they're known
 *   onText(piece)                the answer as it's written (never the follow-up line)
 * history: earlier turns [{ q, a }] for follow-up questions.
 * Resolves with { text, followups, sources, model }.
 */
async function answer(q, { history = [], braveKey = '', model = null, signal, onStep = () => {}, onSources = () => {}, onText = () => {} } = {}) {
  // a follow-up like "and how big is it?" needs the earlier question to search well
  const prev = history.slice(-2);
  const searchFor = prev.length && q.split(/\s+/).length <= 8 ? `${prev[prev.length - 1].q} ${q}` : q;
  const sources = await Search.lookUp(searchFor, { braveKey, signal, onStep });
  onSources(sources);
  if (!model) {
    const err = new Error('NO_AI');
    err.sources = sources;
    throw err;
  }
  onStep({ step: 'write' });
  const messages = [];
  for (const h of prev) { messages.push({ role: 'user', content: h.q }); messages.push({ role: 'assistant', content: String(h.a || '').slice(0, 3000) }); }
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  messages.push({ role: 'user', content: sources.length ? `Sources:\n\n${sourcesBlock(sources)}\n\nQuestion: ${q}` : `(The web search found nothing this time.)\n\nQuestion: ${q}\n\nAnswer from what you know, and say clearly that you couldn't check it on the web.` });
  // stream, holding back anything that might be the start of the follow-up line
  let full = '';
  let sent = 0;
  const flush = (end = false) => {
    const cut = full.search(/\n?\s*\**FOLLOW-?UPS?/i);
    const safe = cut >= 0 ? cut : end ? full.length : Math.max(sent, full.length - 14);
    if (safe > sent) { onText(full.slice(sent, safe)); sent = safe; }
  };
  const r = await AI.stream({ model, system: system(today), messages, signal, onText: (t) => { full += t; flush(); } });
  full = r.text || full;
  flush(true);
  const { text, followups } = splitFollowups(full);
  return { text, followups, sources, model: r.model };
}

module.exports = { answer, splitFollowups, cited, system, sourcesBlock };
