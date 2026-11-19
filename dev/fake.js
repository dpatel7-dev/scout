'use strict';
// A pretend internet for scout's tests: a DuckDuckGo-style results page, a few
// web pages, Wikipedia, and an AI that answers in scout's format.
//
//   node dev/fake.js 9911
//   SCOUT_URL_DDG=http://127.0.0.1:9911/html SCOUT_URL_WIKI=http://127.0.0.1:9911 TOT_URL_GROQ=http://127.0.0.1:9911/v1 scout why is the sky blue

const http = require('http');

const PAGES = {
  1: ['Why Is the Sky Blue? | NASA Space Place', 'Sunlight reaches Earth\'s atmosphere and is scattered in all directions by all the gases and particles in the air. Blue light is scattered more than the other colors because it travels as shorter, smaller waves. This is why we see a blue sky most of the time.'],
  2: ['Rayleigh scattering explained - Science Daily', 'Rayleigh scattering is the scattering of light by particles much smaller than the wavelength of the light. The amount of scattering is inversely proportional to the fourth power of the wavelength, so violet and blue light scatter far more than red.'],
  3: ['Why sunsets are red - Weather Guide', 'At sunrise and sunset, light passes through much more air before it reaches your eyes. Most of the blue is scattered away, leaving the reds and oranges to come through.'],
  4: ['Ads and cookies', '<script>var x = 1;</script>'],
};

function answer(user) {
  if (/^PASTED/m.test(user)) {
    if (/kind,|,name|^name,/m.test(user) || /a table/.test(user)) return '**This is a list of 3 people and their ages.**\n\n| Name | Age |\n| --- | --- |\n| Ana | 31 |\n| Ben | 27 |\n| Cy | 45 |\n\nThe oldest is Cy, and the average age is about 34.\nFOLLOWUPS: Sort it by age | Add a column | Make a chart';
    return '**This is a small Python function that adds two numbers.**\n\n```python\ndef add(a, b):\n    # add them\n    return a + b\n```\n\n- It takes two numbers and gives back their sum.\n- There are no bugs.\nFOLLOWUPS: Add type hints | Write a test | Explain return';
  }
  if (/Message: (hi|hello|thanks)/i.test(user)) return 'Hi! Ask me anything, or paste something and I will explain it.\nFOLLOWUPS: What can you do? | Explain a web page | Tidy my notes';
  const q = (/(?:Question|Message): (.*)$/m.exec(user) || [])[1] || 'that';
  const n = (user.match(/^\[\d+\]/gm) || []).length;
  return `**The sky looks blue because air scatters blue sunlight much more than red light.** [1][2]\n\n- Sunlight has every colour in it. [1]\n- Blue light travels in short waves, so tiny bits of air bounce it all over the sky. [2]\n- At sunset the light goes through more air, so the blue is used up and the sky turns red. [3]\n\n(${n} sources, about: ${q})\nFOLLOWUPS: Why are sunsets red? | Is the sky blue on Mars? | What is Rayleigh scattering?`;
}

function start(port = 0, { slow = 0 } = {}) {
  const log = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const self = `http://127.0.0.1:${server.address().port}`;
      log.push(u.pathname);
      if (u.pathname.startsWith('/html')) {
        res.setHeader('content-type', 'text/html');
        const item = (i) => `<div class="result"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(`${self.replace('127.0.0.1', i % 2 ? '127.0.0.1' : 'localhost')}/page/${i}`)}&amp;rut=abc">${PAGES[i][0].replace('&', '&amp;')}</a></h2><a class="result__snippet" href="#">A snippet about page <b>${i}</b> &amp; more.</a></div>`;
        return res.end(`<html><body><div class="ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">An ad</a></div>${[1, 2, 3, 4].map(item).join('')}</body></html>`);
      }
      const pm = /^\/page\/(\d+)$/.exec(u.pathname);
      if (pm && PAGES[pm[1]]) {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        const [t, p] = PAGES[pm[1]];
        return res.end(`<html><head><title>${t}</title><meta name="description" content="About ${t}"><meta property="og:site_name" content="Site ${pm[1]}"></head><body><nav><p>Home · About · Contact us today for more</p></nav><article><h1>${t}</h1><p>${p}</p><p>Subscribe to our newsletter for more.</p></article><footer><p>All rights reserved, this footer is long enough to count.</p></footer></body></html>`);
      }
      if (u.pathname === '/w/api.php') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ query: { search: [{ title: 'Diffuse sky radiation' }] } })); }
      if (u.pathname.startsWith('/api/rest_v1/page/summary/')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ type: 'standard', title: 'Diffuse sky radiation', description: 'Sunlight scattered by the atmosphere', extract: 'Diffuse sky radiation is solar radiation reaching the Earth\'s surface after having been scattered from the direct solar beam by molecules in the atmosphere.', content_urls: { desktop: { page: `${self}/wiki/Diffuse_sky_radiation` } } })); }
      if (u.pathname === '/v1/chat/completions') {
        const j = JSON.parse(body || '{}');
        const user = (j.messages.filter((m) => m.role === 'user').pop() || {}).content || '';
        const text = /Say OK/.test(user) ? 'OK' : answer(user);
        res.setHeader('content-type', 'text/event-stream');
        let k = 0;
        const step = () => {
          if (k >= text.length) { res.end('data: [DONE]\n\n'); return; }
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(k, k + 24) } }] })}\n\n`);
          k += 24;
          setTimeout(step, slow);
        };
        return step();
      }
      if (u.pathname === '/v1/models') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'llama-3.3-70b-versatile' }] })); }
      res.statusCode = 404;
      res.end('not here');
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, log, port: server.address().port, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

if (require.main === module) start(Number(process.argv[2]) || 9911, { slow: 25 }).then((f) => console.log(`pretend internet on ${f.url}`));

module.exports = { start };
