'use strict';
// Turning a message into an answer. A message can be a question, small talk,
// a link, or something pasted in (code, a table, JSON, an essay…). scout looks
// things up only when that helps, reads any links you gave it, and answers
// in plain words with every fact pointing at where it came from.

const AI = require('./ai');
const Search = require('./search');

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/g;
const SMALL_TALK = /^(hi|hii+|hello|hey|yo|sup|thanks|thank you|thx|ty|ok|okay|cool|nice|great|lol|haha|bye|good (morning|night|evening|afternoon)|who are you|what are you)\b[\s!.?]*$/i;
const WANTS_WEB = /\b(search|look (it |this |that )?up|google|latest|newest|news|today|tonight|this week|current(ly)?|right now|price|cost|weather|score|20[2-3]\d)\b/i;
const KINDS = { text: 'text', markdown: 'text', code: 'code', json: 'JSON', table: 'a table' };

/** Decide what to do with a message: which links to read, and whether to search the web. */
function plan(q, { pasted = [], search = true } = {}) {
  const text = String(q || '').trim();
  const urls = [...new Set(text.match(URL_RE) || [])].slice(0, 3);
  const words = text.replace(URL_RE, ' ').trim();
  const web = !!search && words.length > 1 && !SMALL_TALK.test(words) && (!pasted.length || WANTS_WEB.test(words)) && !(urls.length && !WANTS_WEB.test(words));
  return { urls, web, query: words };
}

function system(today, { deep = false } = {}) {
  return `You are Pip, a friendly owl inside scout, a chat app that can look things up on the web and read what people paste in. Today is ${today}.
Many people who use scout read slowly or are new to a topic. Write so anyone can follow:
- For a question: start with the answer itself in one or two plain sentences, in **bold**. No greeting, no "Great question". Then the useful details as short bullet points or a few short paragraphs.
- For small talk, just reply naturally in a sentence or two.
- Use everyday words and short sentences. Explain any hard word the first time.
- When you're given sources, use them for facts and put the source number in square brackets right after each fact, like [1] or [2][4]. Never invent a source or a number. If sources disagree, say so. If they don't answer the question, say what they do say.
- When they PASTED something, work with it directly. If they asked about it, answer that. If they didn't ask anything, first show it tidied up in the clearest form (a table for data, a code block with its language for code, headings and bullet points for long writing, fixed spelling and punctuation for messy text), then explain in a few lines what it is and anything worth noticing (mistakes, bugs, totals, the main point). Keep code exactly as it was unless they ask for changes.
- Use a small table when comparing things. Put code in fenced code blocks with the language name.
- ${deep ? 'They asked for a deeper answer: up to about 450 words, with ## headings for the parts.' : 'Keep it short: most answers fit in 150 words. Tidied-up pasted material can be as long as the material itself.'}
- On the very last line, write: FOLLOWUPS: then three short things the person might ask next, separated by " | ".`;
}

function sourcesBlock(sources) {
  return sources.map((s) => `[${s.n}] ${s.title} (${s.domain})\n${(s.text || s.snippet || '').slice(0, 3500)}`).join('\n\n');
}

/** What they pasted, labelled for the AI. Long pastes are cut to keep within what models can read. */
function pastedBlock(pasted, budget = 24000) {
  let left = budget;
  return pasted.map((p, i) => {
    const lines = String(p.text).split('\n').length;
    let body = String(p.text);
    if (body.length > left) body = body.slice(0, Math.max(0, left)) + '\n… (the rest was cut: it was too long)';
    left -= body.length;
    const what = [KINDS[p.kind] || 'text', p.lang && p.kind === 'code' ? p.lang : '', p.name ? `from the file ${p.name}` : '', `${lines} line${lines === 1 ? '' : 's'}`].filter(Boolean).join(', ');
    return `PASTED ${pasted.length > 1 ? `#${i + 1} ` : ''}(${what}):\n<<<\n${body}\n>>>`;
  }).join('\n\n');
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

/** A short line about a turn's paste, to remind the AI of it in later turns. */
function pasteNote(pasted = []) {
  return pasted.length ? `\n\n(Earlier I pasted: ${pasted.map((p) => `${KINDS[p.kind] || 'text'}${p.name ? ` "${p.name}"` : ''}, starting "${String(p.text).slice(0, 160).replace(/\s+/g, ' ')}…"`).join('; ')})` : '';
}

/**
 * Answer one message. Calls:
 *   onStep({ step, count })      search / read / done / write
 *   onSources(sources)           as soon as they're known
 *   onText(piece)                the answer as it's written (never the follow-up line)
 * history: earlier turns [{ q, a, pasted }]. pasted: [{ kind, lang, name, text }].
 * Resolves with { text, followups, sources, model, searched }.
 */
async function answer(q, { history = [], pasted = [], search = true, deep = false, braveKey = '', model = null, signal, onStep = () => {}, onSources = () => {}, onText = () => {} } = {}) {
  const p = plan(q, { pasted, search });
  const prev = history.slice(-6);
  let sources = [];
  // links they gave: read those first, they're what the question is about
  if (p.urls.length) {
    onStep({ step: 'read', count: p.urls.length });
    const read = await Promise.all(p.urls.map((u) => Search.read({ url: u, title: '' }, { signal })));
    sources = read.filter((s) => !s.failed).map((s) => ({ ...s, domain: Search.domainOf(s.url) }));
  }
  if (p.web) {
    // a follow-up like "and how big is it?" needs the earlier question to search well
    const last = prev[prev.length - 1];
    const searchFor = last && p.query.split(/\s+/).length <= 8 ? `${last.q} ${p.query}` : p.query;
    const found = await Search.lookUp(searchFor, { braveKey, signal, pages: deep ? 8 : 5, onStep });
    const have = new Set(sources.map((s) => s.url));
    sources = sources.concat(found.filter((s) => !have.has(s.url)));
  }
  sources = sources.slice(0, deep ? 10 : 7).map((s, i) => ({ n: i + 1, title: s.title || Search.domainOf(s.url), url: s.url, domain: s.domain || Search.domainOf(s.url), site: s.site || '', snippet: s.snippet || s.description || '', text: s.text || '', image: s.image || null }));
  onSources(sources);
  if (!model) {
    const err = new Error('NO_AI');
    err.sources = sources;
    throw err;
  }
  onStep({ step: 'write' });
  const messages = [];
  for (const h of prev) { messages.push({ role: 'user', content: (h.q || '(pasted something)') + pasteNote(h.pasted) }); messages.push({ role: 'assistant', content: String(h.a || '').slice(0, 2500) }); }
  const parts = [];
  if (sources.length) parts.push(`Sources:\n\n${sourcesBlock(sources)}`);
  if (pasted.length) parts.push(pastedBlock(pasted));
  if (p.web && !sources.length) parts.push('(You searched the web but found nothing useful this time. If you answer from what you know, say that you couldn\'t check it.)');
  parts.push(String(q || '').trim() ? `Message: ${String(q).trim()}` : 'Message: (none: they only pasted the above)');
  messages.push({ role: 'user', content: parts.join('\n\n') });
  // stream, holding back anything that might be the start of the follow-up line
  let full = '';
  let sent = 0;
  const flush = (end = false) => {
    const cut = full.search(/\n?\s*\**FOLLOW-?UPS?/i);
    const safe = cut >= 0 ? cut : end ? full.length : Math.max(sent, full.length - 14);
    if (safe > sent) { onText(full.slice(sent, safe)); sent = safe; }
  };
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const r = await AI.stream({ model, system: system(today, { deep }), messages, signal, onText: (t) => { full += t; flush(); } });
  full = r.text || full;
  flush(true);
  const { text, followups } = splitFollowups(full);
  return { text, followups, sources, model: r.model, searched: p.web };
}

/** Rough kind of some pasted text (the page has a fuller version): code, json, table or text. */
function kindOf(text) {
  const t = String(text || '').trim();
  if (/^[[{]/.test(t)) { try { JSON.parse(t); return { kind: 'json' }; } catch { /* not JSON */ } }
  const lines = t.split('\n').filter((l) => l.trim());
  if (lines.length >= 2 && lines.every((l) => l.split('\t').length === lines[0].split('\t').length && l.includes('\t'))) return { kind: 'table' };
  if (/(^|\n)\s*(def |class |import |from \S+ import|function |const |let |#include|public |SELECT |<\w+[^>]*>)|[;{}]\s*$/m.test(t)) return { kind: 'code' };
  return { kind: 'text' };
}

module.exports = { answer, plan, splitFollowups, cited, system, sourcesBlock, pastedBlock, kindOf };
