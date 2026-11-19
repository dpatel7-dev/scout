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
const { splitFollowups, cited } = require('../src/answer');
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

/** Ask the server and collect its events. */
async function ask(url, q, history = []) {
  const r = await fetch(url + 'api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q, history }) });
  const raw = await r.text();
  return raw.split('\n\n').filter(Boolean).map((b) => ({ type: /^event: (.*)$/m.exec(b)[1], data: JSON.parse(/^data: (.*)$/m.exec(b)[1]) }));
}

test('a whole question: search, read, answer with sources and follow-ups', async () => {
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
    const steps = ev.filter((e) => e.type === 'step').map((e) => e.data.step);
    assert.deepStrictEqual(steps, ['search', 'read', 'done', 'write']);
    const sources = ev.find((e) => e.type === 'sources').data;
    assert.ok(sources.some((x) => /Wikipedia/.test(x.title)), 'Wikipedia is one of them');
    assert.ok(sources.every((x) => x.n && x.url && x.domain && !('text' in x)), 'numbered, without the page text');
    assert.ok(!sources.some((x) => /Ads and cookies/.test(x.title)), 'a page with nothing to read is left out');
    const text = ev.filter((e) => e.type === 'text').map((e) => e.data).join('');
    assert.match(text, /\*\*The sky looks blue/);
    assert.match(text, /\[1\]/);
    assert.ok(!/FOLLOWUPS/.test(text), 'the follow-up line never shows');
    const done = ev.find((e) => e.type === 'done').data;
    assert.deepStrictEqual(done.followups, ['Why are sunsets red?', 'Is the sky blue on Mars?', 'What is Rayleigh scattering?']);

    // it's remembered, and can be opened again
    const st = await (await fetch(s.url + 'api/state')).json();
    assert.strictEqual(st.recent[0].q, 'why is the sky blue');
    const past = await (await fetch(s.url + 'api/past/' + done.id)).json();
    assert.match(past.a, /sky looks blue/);

    // only this computer, at the secret address
    assert.strictEqual((await fetch(s.url.replace(/\/[^/]+\/$/, '/nope/'))).status, 404);
  } finally {
    await s.close();
    await fake.close();
  }
});

test('the page is served with its settings filled in', async () => {
  const { serve } = require('../src/server');
  const s = await serve();
  try {
    const html = await (await fetch(s.url)).text();
    assert.match(html, /What do you want to know\?/);
    assert.ok(!html.includes('/*SCOUT*/{}'), 'config filled in');
  } finally { await s.close(); }
});
