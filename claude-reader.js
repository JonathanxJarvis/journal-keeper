/* Claude reader: sends one page photo to Claude and gets back the typed text.
   Uses the owner's own Anthropic API key, kept only on this phone.
   Pages go straight from the phone to Anthropic; there is no other server. */
const ClaudeReader = (() => {
  const MODELS = {
    'claude-sonnet-5': { name: 'Sonnet 5', inPerM: 2, outPerM: 10 },
    'claude-opus-5': { name: 'Opus 5', inPerM: 5, outPerM: 25 },
  };
  const LONG_EDGE = 1600;   // enough for handwriting, keeps each page around 2,500 image tokens

  const get = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch { /* not important */ } };

  const key = () => (get('jk-claude-key', '') || '').trim();
  const setKey = (v) => set('jk-claude-key', (v || '').trim());
  const model = () => (MODELS[get('jk-claude-model')] ? get('jk-claude-model') : 'claude-sonnet-5');
  const setModel = (v) => { if (MODELS[v]) set('jk-claude-model', v); };
  const hint = () => (get('jk-claude-hint', '') || '').trim();
  const setHint = (v) => set('jk-claude-hint', (v || '').trim());

  function spent() {
    try { return JSON.parse(get('jk-claude-spent', '')) || { usd: 0, pages: 0 }; } catch { return { usd: 0, pages: 0 }; }
  }
  function addSpent(usd) {
    const s = spent();
    s.usd += usd; s.pages += 1;
    set('jk-claude-spent', JSON.stringify(s));
  }

  let sdkP = null;
  function client() {
    if (!sdkP) sdkP = import(new URL('vendor/anthropic-sdk.mjs', location.href).href).catch((e) => { sdkP = null; throw e; });
    // The key belongs to the person using the app and never leaves their phone except to Anthropic.
    return sdkP.then((m) => new m.default({ apiKey: key(), dangerouslyAllowBrowser: true, maxRetries: 4 }));
  }

  async function pagePicture(blob) {
    const bmp = await createImageBitmap(blob);
    const s = Math.min(1, LONG_EDGE / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close && bmp.close();
    const url = c.toDataURL('image/jpeg', 0.85);
    return url.slice(url.indexOf(',') + 1);
  }

  const SCHEMA = {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Everything written on the page, line by line, exactly as written.' },
      title: { type: 'string', description: 'A short title of at most 8 words for the page, taken from its content.' },
      date: { type: 'string', description: 'The date written on the page as YYYY-MM-DD, or YYYY-MM or YYYY if only partly given. Empty if there is no date.' },
      upside_down: { type: 'boolean', description: 'true if the writing in the photo is upside down (turned 180 degrees), false if it is the right way up or turned only sideways.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Up to 5 short lowercase topics (people, places, themes).' },
    },
    required: ['text', 'title', 'date', 'upside_down', 'tags'],
    additionalProperties: false,
  };

  function prompt(ctx) {
    let extra = hint() ? `\n\nNotes from the family about this writer and these journals:\n${hint()}` : '';
    if (ctx && ctx.journal) extra += `\n\nThis page is from the journal "${ctx.journal}".`;
    if (ctx && ctx.prevDate) extra += ` The last dated page before it in this journal is from ${ctx.prevDate}.`;
    extra += '\n\nOnly give a date if one is written on this page. If a day and month are written without a year, take the year from the context above.';
    return 'This is a photo of one handwritten journal page. Transcribe it faithfully: keep the writer\'s own words, spelling and line breaks, ' +
      'and do not correct, summarise or add anything. Ignore ruled lines and writing that shows through from the other side of the paper. ' +
      'If a word cannot be read, write your best guess followed by [?]. Keep the original language. ' +
      'The photo may be upside down: read it the right way up, and say whether the writing in the photo as given is upside down.' + extra;
  }

  // Returns { text, title, date, tags, usd }. Throws an Error with a plain-language message and a .kind.
  async function read(blob, ctx) {
    if (!key()) throw Object.assign(new Error('Add your Claude API key in the menu first.'), { kind: 'key' });
    const [api, data] = await Promise.all([client(), pagePicture(blob)]);
    let res;
    try {
      res = await api.messages.create({
        model: model(),
        max_tokens: 8000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
            { type: 'text', text: prompt(ctx) },
          ],
        }],
      });
    } catch (e) {
      throw explain(e);
    }
    const m = MODELS[model()];
    const u = res.usage || {};
    const usd = ((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)) * m.inPerM / 1e6 +
      (u.cache_read_input_tokens || 0) * m.inPerM * 0.1 / 1e6 +
      (u.output_tokens || 0) * m.outPerM / 1e6;
    addSpent(usd);
    if (res.stop_reason === 'refusal') {
      throw Object.assign(new Error('Claude would not read this page. Type it in by hand.'), { kind: 'page' });
    }
    if (res.stop_reason === 'max_tokens') {
      throw Object.assign(new Error('The page was too long to read in one go. Try a photo of half the page.'), { kind: 'page' });
    }
    const out = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let parsed;
    try { parsed = JSON.parse(out); } catch { parsed = { text: out, title: '', date: '', tags: [] }; }
    return {
      text: String(parsed.text || '').trim(),
      title: String(parsed.title || '').trim(),
      date: /^\d{4}(-\d{2}){0,2}$/.test(parsed.date || '') ? parsed.date : '',
      tags: Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 5) : [],
      // quarter-turns needed to stand the page upright
      turns: parsed.upside_down === true ? 2 : 0,
      usd,
    };
  }

  function explain(e) {
    const status = e && e.status;
    const body = String((e && e.message) || e);
    if (status === 401 || status === 403) return Object.assign(new Error('The Claude API key was not accepted. Check it in the menu.'), { kind: 'key' });
    if (status === 400 && /credit|balance|billing/i.test(body)) return Object.assign(new Error('Your Claude credit has run out. Add credit at console.anthropic.com, then tap "Read all unchecked pages with Claude" in the menu.'), { kind: 'credit' });
    if (status === 429 || status === 529 || status >= 500) return Object.assign(new Error('Claude is busy right now. The page will be read later.'), { kind: 'later' });
    if (!status || navigator.onLine === false) return Object.assign(new Error('No internet connection. The page will be read when you are back online.'), { kind: 'later' });
    return Object.assign(new Error(`Claude could not read this page (${body.slice(0, 140)}).`), { kind: 'page' });
  }

  async function test() {
    if (!key()) throw new Error('Paste the key first.');
    const api = await client();
    try {
      await api.messages.create({ model: model(), max_tokens: 16, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'Say OK.' }] });
    } catch (e) { throw explain(e); }
  }

  return { MODELS, key, setKey, model, setModel, hint, setHint, spent, read, test, ready: () => !!key() };
})();
