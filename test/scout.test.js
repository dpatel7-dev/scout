'use strict';
// scout's tests: reading search results and pages, then a whole question
// against a pretend internet and a pretend AI.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-test-'));
process.env.SCOUT_HOME = path.join(tmp, 'scout');
process.env.TOT_HOME = path.join(tmp, 'tot');
process.env.TOT_URL_OLLAMA = 'http://127.0.0.1:1/v1'; // no Ollama here
process.env.SCOUT_NO_BROWSER = '1';

const Search = require('../src/search');
const { splitFollowups, cited, plan, pastedBlock, kindOf } = require('../src/answer');
const Fake = require('../dev/fake');

test('DuckDuckGo results: real links, titles and snippets; ads left out', () => {
  const html = '<a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a>'
    + '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&amp;rut=x">Example &amp; Co</a><a class="result__snippet">The <b>best</b> one</a>'
    + '<a class="result__a" href="https://second.org/page">Second</a><div class="result__snippet">Two</div>';
  const r = Search.parseDuck(html);
  assert.deepStrictEqual(r.map((x) => x.url), ['https://example.com/a?b=1', 'https://second.org/page']);
  assert.strictEqual(r[0].title, 'Example & Co');
  assert.strictEqual(r[0].snippet, 'The best one');
});

test('a page boils down to its readable text', () => {
  const p = Search.readable('<html><head><title>Cats &amp; dogs</title><meta property="og:site_name" content="Pets"></head><body><nav><p>Menu menu menu menu menu menu menu</p></nav><script>alert(1)</script><article><h2>How long cats live</h2><p>Indoor cats usually live between 12 and 18 years, and some reach their twenties.</p><p>Sign up for our newsletter to get more cat facts every week!</p></article></body></html>');
  assert.strictEqual(p.title, 'Cats & dogs');
  assert.strictEqual(p.site, 'Pets');
  assert.match(p.text, /12 and 18 years/);
  assert.match(p.text, /## How long cats live/);
  assert.ok(!/alert|Menu|newsletter/.test(p.text));
});

test('the follow-up questions are split off the answer', () => {
  const r = splitFollowups('**Yes.** [1]\n\n- a\nFOLLOWUPS: One? | Two? | Three?');
  assert.strictEqual(r.text, '**Yes.** [1]\n\n- a');
  assert.deepStrictEqual(r.followups, ['One?', 'Two?', 'Three?']);
  assert.deepStrictEqual(splitFollowups('Just text').followups, []);
  assert.deepStrictEqual([...cited('a [1] b [3][1]')], [1, 3]);
});

test('scout searches only when it helps', () => {
  assert.strictEqual(plan('why is the sky blue').web, true);
  assert.strictEqual(plan('hi!').web, false, 'small talk');
  assert.strictEqual(plan('thanks').web, false);
  assert.strictEqual(plan('what does this do', { pasted: [{ text: 'x' }] }).web, false, 'the paste is the material');
  assert.strictEqual(plan('is this the latest version?', { pasted: [{ text: 'x' }] }).web, true, 'unless they ask to look it up');
  assert.strictEqual(plan('why is the sky blue', { search: false }).web, false, 'search switched off');
  const u = plan('summarize https://example.com/a and https://example.com/b');
  assert.deepStrictEqual(u.urls, ['https://example.com/a', 'https://example.com/b']);
  assert.strictEqual(u.web, false, 'reads the links instead of searching');
  assert.strictEqual(plan('', { pasted: [{ text: 'x' }] }).web, false);
});

test('pasted material is labelled for the AI, and very long pastes are cut', () => {
  const b = pastedBlock([{ kind: 'code', lang: 'python', text: 'def f():\n    return 1' }, { kind: 'table', name: 'people.csv', text: 'a,b\n1,2' }]);
  assert.match(b, /PASTED #1 \(code, python, 2 lines\)/);
  assert.match(b, /PASTED #2 \(a table, from the file people\.csv, 2 lines\)/);
  assert.match(pastedBlock([{ kind: 'text', text: 'x'.repeat(30000) }], 1000), /the rest was cut/);
  assert.strictEqual(kindOf('{"a": 1}').kind, 'json');
  assert.strictEqual(kindOf('def f():\n    return 1').kind, 'code');
  assert.strictEqual(kindOf('a\tb\n1\t2').kind, 'table');
  assert.strictEqual(kindOf('Dear Sam, thanks for the cake.').kind, 'text');
});

/** Send a message and collect the events. */
async function ask(url, body) {
  const r = await fetch(url + 'api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(typeof body === 'string' ? { q: body } : body) });
  const raw = await r.text();
  return raw.split('\n\n').filter(Boolean).map((b) => ({ type: /^event: (.*)$/m.exec(b)[1], data: JSON.parse(/^data: (.*)$/m.exec(b)[1]) }));
}
const textOf = (ev) => ev.filter((e) => e.type === 'text').map((e) => e.data).join('');

test('a whole chat: search and answer, a follow-up, a paste, a link, and the chat kept', async () => {
  const fake = await Fake.start();
  process.env.SCOUT_URL_DDG = `${fake.url}/html`;
  process.env.SCOUT_URL_WIKI = fake.url;
  process.env.TOT_URL_GROQ = `${fake.url}/v1`;
  const { serve } = require('../src/server');
  const s = await serve();
  try {
    // no AI yet: scout still shows what it found, and asks for a key
    let ev = await ask(s.url, 'why is the sky blue');
    const noai = ev.find((e) => e.type === 'noai');
    assert.ok(noai, 'says there is no AI');
    assert.ok(noai.data.sources.length >= 2, 'but still found sources');

    // add a free key from the page (the pretend Groq accepts it)
    const k = await fetch(s.url + 'api/key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'groq', key: 'gsk_pretendpretendpretend' }) });
    assert.strictEqual(k.status, 200);
    assert.strictEqual((await k.json()).model.name, 'Llama 3.3 70B');
    assert.ok(JSON.parse(fs.readFileSync(path.join(process.env.TOT_HOME, 'keys.json'), 'utf8')).groq, 'the key is shared with Tree of Thought');

    ev = await ask(s.url, 'why is the sky blue');
    const chat = ev.find((e) => e.type === 'chat').data.id;
    assert.deepStrictEqual(ev.filter((e) => e.type === 'step').map((e) => e.data.step), ['search', 'read', 'done', 'write']);
    const sources = ev.find((e) => e.type === 'sources').data;
    assert.ok(sources.some((x) => /Wikipedia/.test(x.title)), 'Wikipedia is one of them');
    assert.ok(sources.every((x) => x.n && x.url && x.domain && !('text' in x)), 'numbered, without the page text');
    assert.ok(!sources.some((x) => /Ads and cookies/.test(x.title)), 'a page with nothing to read is left out');
    assert.match(textOf(ev), /\*\*The sky looks blue/);
    assert.ok(!/FOLLOWUPS/.test(textOf(ev)), 'the follow-up line never shows');
    assert.deepStrictEqual(ev.find((e) => e.type === 'done').data.followups, ['Why are sunsets red?', 'Is the sky blue on Mars?', 'What is Rayleigh scattering?']);

    // small talk in the same chat: no searching, and the earlier turn goes along
    const before = fake.log.length;
    ev = await ask(s.url, { q: 'thanks', chat });
    assert.match(textOf(ev), /^Hi!/);
    assert.ok(!fake.log.slice(before).some((p) => p.startsWith('/html')), 'no web search for small talk');
    assert.strictEqual(ev.find((e) => e.type === 'done').data.searched, false);

    // paste some code with no question: tidied up and explained, no searching
    ev = await ask(s.url, { q: '', chat, pasted: [{ kind: 'code', lang: 'python', text: 'def add(a,b):\n  return a+b' }] });
    assert.match(textOf(ev), /```python/);
    assert.deepStrictEqual(ev.find((e) => e.type === 'sources').data, []);

    // a link: scout reads that page, it becomes source 1
    ev = await ask(s.url, { q: `what does this say? ${fake.url}/page/1`, chat });
    const linked = ev.find((e) => e.type === 'sources').data;
    assert.strictEqual(linked.length, 1);
    assert.match(linked[0].title, /NASA/);

    // the whole chat is kept, and can be opened and deleted
    let st = await (await fetch(s.url + 'api/state')).json();
    assert.strictEqual(st.chats[0].id, chat);
    assert.strictEqual(st.chats[0].title, 'why is the sky blue');
    const full = await (await fetch(s.url + 'api/chat/' + chat)).json();
    assert.strictEqual(full.turns.length, 4);
    assert.strictEqual(full.turns[2].pasted[0].lang, 'python');
    // try again replaces the last answer instead of adding one
    await ask(s.url, { q: 'thanks', chat, retry: true });
    assert.strictEqual((await (await fetch(s.url + 'api/chat/' + chat)).json()).turns.length, 4);
    st = await (await fetch(s.url + `api/chat/${chat}/delete`, { method: 'POST' })).json();
    assert.ok(!st.chats.some((c) => c.id === chat));

    // nothing to answer
    ev = await ask(s.url, { q: '  ' });
    assert.match(ev[0].data.message, /Type a question/);

    // only this computer, at the secret address
    assert.strictEqual((await fetch(s.url.replace(/\/[^/]+\/$/, '/nope/'))).status, 404);
  } finally {
    await s.close();
    await fake.close();
  }
});

test('chats from scout 1.0 come along', () => {
  const { chats, home } = require('../src/server');
  fs.mkdirSync(home(), { recursive: true });
  try { fs.unlinkSync(path.join(home(), 'chats.json')); } catch { /* fine */ }
  fs.writeFileSync(path.join(home(), 'history.json'), JSON.stringify([{ id: 'old1', q: 'old question', a: 'old answer', at: 5, sources: [] }]));
  const all = chats.load();
  assert.strictEqual(all[0].title, 'old question');
  assert.strictEqual(all[0].turns[0].a, 'old answer');
});

test('the page is served with its settings filled in', async () => {
  const { serve } = require('../src/server');
  const s = await serve();
  try {
    const html = await (await fetch(s.url)).text();
    assert.match(html, /Ask anything, or paste something/);
    assert.ok(!html.includes('/*SCOUT*/{}'), 'config filled in');
  } finally { await s.close(); }
});
