'use strict';
// scout's commands.
//
//   scout                       open scout's page (a window of its own if you have Chrome or Edge)
//   scout how do magnets work   answer right here in the terminal

const os = require('os');
const path = require('path');
const A = require('./ansi');
const AI = require('./ai');
const { answer, kindOf } = require('./answer');
const pkg = require('../package.json');

const home = () => process.env.SCOUT_HOME || path.join(os.homedir(), '.scout');
const say = (s = '') => process.stdout.write(s + '\n');
const C = { owl: '#e8a33a', ink: '#f3e6cc', dim: '#9a8f80', faint: '#6b625a', link: '#7cc6d6', ok: '#8fd16a', err: '#ff7a6b' };
const paint = (s, fg, extra = {}) => A.paint(s, { fg, ...extra });

const HELP = `
  scout ${pkg.version} - ask anything: scout looks it up on the web and explains what it found

  scout                          open scout in a window (type your question there)
  scout <your question>          get the answer right here, for example:
                                   scout how do noise cancelling headphones work
                                   scout best free video editor for mac
  pbpaste | scout                what you copied, tidied up and explained
  cat notes.txt | scout <ask>    ask about a file, for example: cat essay.txt | scout fix my spelling
  scout update                   get the newest scout
  scout uninstall                remove scout (add --all to remove its history too)
  scout --version                which scout this is
`;

/** A little markdown for the terminal: bold, bullets, headings, citations in colour. */
function render(md, width) {
  const w = Math.max(30, Math.min(100, width) - 4);
  const out = [];
  // tables: line the columns up
  const lines = [];
  let table = [];
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.map((l) => l.replace(/^\s*\||\|\s*$/g, '').split('|').map((c) => c.trim().replace(/\*\*/g, '')));
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => A.vwidth(r[i] || ''))));
    rows.forEach((r, k) => lines.push('\u0003' + r.map((c, i) => (k === 0 ? A.paint(c, { bold: true, fg: C.dim }) : c) + ' '.repeat(Math.max(0, widths[i] - A.vwidth(c)))).join('   ')));
    table = [];
  };
  for (const l of String(md).split('\n')) {
    if (/^\s*\|/.test(l)) { if (!/^\s*\|?\s*:?-{3,}/.test(l)) table.push(l); continue; }
    flushTable();
    lines.push(l);
  }
  flushTable();
  for (const raw of lines) {
    if (raw.startsWith('\u0003')) { out.push('  ' + raw.slice(1)); continue; }
    let line = raw.replace(/\s+$/, '');
    if (!line.trim()) { if (out.length && out[out.length - 1] !== '') out.push(''); continue; }
    if (/^\s*\|?\s*:?-{3,}/.test(line)) continue; // table rule
    let lead = '  ';
    let hang = '  ';
    let heading = false;
    const h = /^#{1,4}\s+(.*)$/.exec(line);
    const b = /^(\s*)[-*•]\s+(.*)$/.exec(line);
    const n = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (h) { line = h[1]; heading = true; }
    else if (b) { lead = '  ' + b[1] + paint('•', C.owl) + ' '; hang = '  ' + b[1] + '  '; line = b[2]; }
    else if (n) { lead = '  ' + n[1] + paint(n[2] + '.', C.owl) + ' '; hang = '  ' + n[1] + ' '.repeat(n[2].length + 2); line = n[3]; }
    else if (/^\s*\|/.test(line)) line = line.replace(/^\s*\||\|\s*$/g, '').split('|').map((x) => x.trim()).join('   ');
    // bold can run over a line break, so mark it before wrapping and carry it across lines
    let bold = false;
    const style = (s) => {
      let o = (bold ? '\u0001' : '') + s;
      o = o.replace(/`([^`]+)`/g, (m, x) => paint(x, C.link)).replace(/\[(\d+)\]/g, (m, x) => paint(`[${x}]`, C.owl));
      o = o.replace(/\*\*/g, () => { bold = !bold; return bold ? '\u0001' : '\u0002'; });
      if (bold) o += '\u0002';
      return o.replace(/\u0001([^\u0002]*)\u0002?/g, (m, x) => A.paint(x, { bold: true, fg: C.ink }));
    };
    const words = A.wrap(line, w - A.vwidth(A.strip(hang)));
    words.forEach((l, i) => out.push((i ? hang : lead) + (heading ? A.paint(l, { bold: true, fg: C.owl }) : style(l))));
    if (heading) out.push('');
  }
  return out.join('\n');
}

/** Everything piped in (pbpaste | scout), or null when you're typing. */
function piped() {
  if (process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { s += d; });
    process.stdin.on('end', () => resolve(s.trim() ? s : null));
    process.stdin.on('error', () => resolve(null));
  });
}

async function terminal(q, pastedText = null) {
  const tty = process.stdout.isTTY;
  const width = process.stdout.columns || 80;
  say('');
  const pasted = pastedText ? [{ ...kindOf(pastedText), text: pastedText }] : [];
  say('  ' + A.paint('scout', { bold: true, fg: C.owl }) + paint('  ' + (q || 'what you pasted') + (pasted.length ? `  (+ ${pastedText.trim().split('\n').length} pasted lines)` : ''), C.dim));
  const { model } = await AI.current(require('./server').config.load().model);
  const steps = { search: 'Searching the web…', read: 'Reading', write: 'Writing the answer…' };
  let status = '';
  const show = (s) => { if (!tty) return; process.stdout.write('\r\x1b[2K  ' + paint(s, C.faint)); status = s; };
  const clear = () => { if (tty && status) { process.stdout.write('\r\x1b[2K'); status = ''; } };
  let text = '';
  let r;
  try {
    r = await answer(q, {
      model, pasted, braveKey: require('./server').config.load().braveKey || '',
      onStep: (s) => show(s.step === 'read' ? `Reading ${s.count} ${s.count === 1 ? 'website' : 'websites'}…` : steps[s.step] || ''),
      onText: (t) => { text += t; },
    });
  } catch (e) {
    clear();
    if (e.message === 'NO_AI') {
      say('\n  ' + paint("scout found these, but there's no AI set up yet to explain them:", C.dim) + '\n');
      for (const s of e.sources || []) say(`  ${paint(String(s.n), C.owl)}  ${A.paint(s.title, { bold: true })}\n     ${paint(s.url, C.link)}${s.snippet ? '\n     ' + paint(A.clip(s.snippet, width - 8), C.dim) : ''}\n`);
      say('  ' + paint('To get answers: run scout (no question), click the gear, and paste a free key. It takes a minute.', C.owl) + '\n');
      return;
    }
    throw e;
  }
  clear();
  say('\n' + render(r.text, width) + '\n');
  if (r.sources.length) {
    say('  ' + A.paint('Sources', { bold: true, fg: C.dim }));
    for (const s of r.sources) say(`  ${paint(`[${s.n}]`, C.owl)} ${A.clip(s.title, width - 12)}\n      ${paint(s.url.length > width - 10 ? s.domain : s.url, C.link)}`);
    say('');
  }
  if (r.followups.length) {
    say('  ' + paint('Ask more:', C.dim));
    for (const f of r.followups) say('    ' + paint('scout ', C.faint) + f);
    say('');
  }
  say('  ' + paint(`answered by ${r.model ? r.model.name : 'the AI'} · scout (no question) opens it in a window`, C.faint) + '\n');
}

async function main(argv) {
  const [first, ...rest] = argv;
  const life = require('./life')({ name: 'scout', cmd: 'scout', repo: 'dpatel7-dev/scout', home });
  switch (first) {
    case '--version': case '-v': case 'version': say(`scout ${pkg.version}`); return;
    case 'help': case '--help': case '-h': say(HELP); return;
    case 'update': return life.update();
    case 'uninstall': return life.uninstall(rest.includes('--all'));
    case undefined: case 'open': case 'window': case '--no-open': {
      if (first === undefined) { const text = await piped(); if (text) return terminal('', text); }
      const { serve } = require('./server');
      const s = await serve({ port: Number(process.env.SCOUT_PORT) || 0 });
      const { openWindow } = require('./open');
      if (first !== '--no-open' && !rest.includes('--no-open')) openWindow(s.url, { width: 1100, height: 860 });
      say('');
      say('  ' + A.paint('scout', { bold: true, fg: C.owl }) + paint(' is open in a window. Type your question there.', C.dim));
      say('  ' + paint("If it didn't open, copy this into your browser: ", C.faint) + paint(s.url, C.link));
      say('  ' + paint('Keep this Terminal window open while you use it. Press Ctrl+C to stop.', C.faint));
      say('');
      await new Promise(() => {});
      return;
    }
    default: return terminal(argv.join(' '), await piped());
  }
}

module.exports = { main, HELP, render };
