/**
 * One-off pipeline: build src/data/species.raw.json from Wikipedia.
 *
 * Source of truth is Template:Mycomorphbox (curated morphology with fixed value
 * vocabularies) plus the article's plaintext Description for dimensions/colour prose.
 * Nothing here runs at app runtime -- the output is committed.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { extractColor } from './colors';
import { extractHabitat } from './habitat';

const UA = 'mushroom-morpher/0.1 (educational project; https://github.com/local)';
const API = 'https://en.wikipedia.org/w/api.php';

// Wikimedia requires a User-Agent; without one you get 403s.
async function getJSON(url: string, soft = false): Promise<any> {
  let last = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.ok) return res.json();
      if (res.status === 404) return null; // pageviews: article with no data
      last = `HTTP ${res.status}`;
      const ra = Number(res.headers.get('retry-after'));
      if (ra) { await sleep(ra * 1000); continue; }
    } catch (e: any) {
      last = e?.message ?? String(e);
    }
    await sleep(Math.min(10000, 500 * 2 ** attempt));
  }
  // soft: caller retries on a later pass (the on-disk cache makes that cheap)
  if (soft) return undefined;
  throw new Error(`failed after retries (${last}): ${url}`);
}

/** Pageviews needs ~1700 one-at-a-time requests; cache so reruns are free. */
const CACHE = 'scripts/.cache-pageviews.json';
const cache: Record<string, number> = existsSync(CACHE)
  ? JSON.parse(readFileSync(CACHE, 'utf8'))
  : {};

/** Full plaintext extracts: TextExtracts caps full extracts at one page per request. */
const ECACHE = 'scripts/.cache-extracts.json';
const extracts: Record<string, string> = existsSync(ECACHE)
  ? JSON.parse(readFileSync(ECACHE, 'utf8'))
  : {};

async function fullExtract(title: string): Promise<string> {
  if (title in extracts) return extracts[title];
  const data = await getJSON(
    q({ action: 'query', prop: 'extracts', explaintext: '1', exsectionformat: 'plain',
        redirects: '1', titles: title }),
  );
  const text = data?.query?.pages?.[0]?.extract ?? '';
  extracts[title] = text;
  return text;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function q(params: Record<string, string>) {
  return `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
}

/**
 * Credit lines come from Commons `Artist`, which is free text; one uploader put
 * an email address in it. Publishing that in a public repo invites scraping, and
 * attribution does not need it -- the linked file page carries the uploader's
 * contact details for anyone who wants them.
 *
 * Only email addresses are stripped. A digit-sequence heuristic for phone
 * numbers matched dates ("2009-11-19_Ramaria_botrytis.jpg") and lifespans
 * ("Jens Wilken Hornemann (1770 - 1841)"), and mangling a real credit is worse
 * than the risk it removes.
 */
function cleanArtist(raw: string | undefined): string {
  const text = (raw ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '')          // email addresses
    .replace(/\(\s*\)/g, '')                            // brackets left behind
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    .trim();
  return text.slice(0, 160) || 'unknown';
}

/** Only https URLs are ever stored; anything else is dropped at the source. */
const httpsOnly = (u: string | undefined | null): string | null =>
  typeof u === 'string' && /^https:\/\//i.test(u) ? u : null;

/** Run jobs with bounded concurrency. */
async function pool<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const chunk = <T,>(a: T[], n: number) =>
  Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

// ---------------------------------------------------------------- step 1: candidates

async function candidateTitles(): Promise<string[]> {
  const titles: string[] = [];
  let cont: string | undefined;
  do {
    const data = await getJSON(
      q({
        action: 'query',
        list: 'embeddedin',
        eititle: 'Template:Mycomorphbox',
        einamespace: '0',
        eilimit: '500',
        ...(cont ? { eicontinue: cont } : {}),
      }),
    );
    titles.push(...data.query.embeddedin.map((p: any) => p.title));
    cont = data.continue?.eicontinue;
  } while (cont);
  return titles;
}

/** Binomials only -- drops genus pages (Amanita) and common-name pages (Puffball). */
const isBinomial = (t: string) => /^[A-Z][a-z]+ [a-z][a-z-]+$/.test(t);

// ---------------------------------------------------------------- step 2: pageviews

function lastTwelveMonths() {
  const end = new Date();
  end.setUTCDate(1);
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - 12);
  const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '') + '00';
  return [fmt(start), fmt(end)];
}

async function pageviews(title: string): Promise<number | undefined> {
  if (title in cache) return cache[title];
  const [from, to] = lastTwelveMonths();
  const art = encodeURIComponent(title.replace(/ /g, '_'));
  const data = await getJSON(
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${art}/monthly/${from}/${to}`,
    true,
  );
  if (data === undefined) return undefined; // throttled -- retry next pass
  const total = data?.items ? data.items.reduce((s: number, it: any) => s + it.views, 0) : 0;
  cache[title] = total;
  await sleep(80); // AQS throttles hard on sustained bursts
  return total;
}

// ---------------------------------------------------------------- step 3: mycomorphbox

/** Extract the {{mycomorphbox ...}} call with brace matching, then split params at depth 0. */
function parseMycomorphbox(wikitext: string): Record<string, string> {
  const start = wikitext.search(/\{\{\s*[Mm]ycomorphbox/);
  if (start < 0) return {};
  let depth = 0;
  let end = start;
  for (let i = start; i < wikitext.length; i++) {
    if (wikitext.startsWith('{{', i)) { depth++; i++; }
    else if (wikitext.startsWith('}}', i)) { depth--; i++; if (depth === 0) { end = i + 1; break; } }
  }
  const body = wikitext.slice(start + 2, end - 2);

  const parts: string[] = [];
  let buf = '';
  let d = 0;
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === '{{' || two === '[[') { d++; buf += two; i++; continue; }
    if (two === '}}' || two === ']]') { d--; buf += two; i++; continue; }
    if (body[i] === '|' && d === 0) { parts.push(buf); buf = ''; continue; }
    buf += body[i];
  }
  parts.push(buf);

  const out: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim();
    const v = p.slice(eq + 1).trim().replace(/<!--[\s\S]*?-->/g, '').trim();
    if (k) out[k] = v;
  }
  return out;
}

/** Collect key, key2, key3 into a cleaned list. */
function multi(box: Record<string, string>, key: string): string[] {
  const vals: string[] = [];
  for (const k of [key, `${key}2`, `${key}3`, `${key}4`]) {
    const raw = box[k];
    if (!raw) continue;
    for (const v of raw.toLowerCase().split(/\s*(?:,|\band\b(?!\s+volva))\s*/)) {
      const t = v.trim();
      if (!t || t === 'na' || t === 'no' || t === 'n/a') continue;
      vals.push(t);
    }
  }
  return [...new Set(vals)];
}

// ---------------------------------------------------------------- step 4: prose traits

const sentences = (text: string) =>
  text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z(])/);

/**
 * Measurements in these articles appear either side of the subject word
 * ("the cap is 3-10 cm", "measuring 3-10 cm in diameter, the cap is furrowed"),
 * in cm or mm, as ranges or single values. So: find every measurement in a
 * sentence, then attribute each to its NEAREST subject word.
 */
const MEASURE_SRC =
  String.raw`(\d+(?:[.,]\d+)?)\s*(?:[-–—]|\s+to\s+)\s*(\d+(?:[.,]\d+)?)(?:\s*\(\s*[-–—]?\s*\d+(?:[.,]\d+)?\s*\))?\s*(cm|mm|centimetres?|centimeters?|millimetres?|millimeters?)\b` +
  String.raw`|(?:up to|about|around|c\.|reaching)\s*(\d+(?:[.,]\d+)?)\s*(cm|mm|centimetres?|centimeters?|millimetres?|millimeters?)\b` +
  String.raw`|(\d+(?:[.,]\d+)?)\s*(cm|mm|centimetres?|centimeters?|millimetres?|millimeters?)\b`;
const MEASURE = new RegExp(MEASURE_SRC, 'gi');

const CAP_WORDS =
  /\b(caps?|pileus|pilei|fruit ?bodies|fruit ?body|fruiting bodies|fruiting body|basidiocarps?|heads?|bodies|body)\b/gi;
const STEM_WORDS = /\b(stipes?|stems?|stalks?)\b/gi;
// Structural parts that genuinely carry their own measurements. Cosmetic features
// (scales, warts, ring, volva) are excluded: they are descriptive adjuncts that sit
// near a stem/cap measurement without owning it ("the stipe is white with olive
// scales and is 8 to 15 cm long").
const OTHER_WORDS =
  /\b(gills?|lamellae?|spores?|pores?|tubes?|teeth|spines?|flesh|cystidia|hyphae|mycelium|mycelia|stroma|asci|ascospores?|basidia)\b/gi;
/** "5-10 cm tall" is a height, not a diameter -- look just past the match. */
const HEIGHT_HINT = /^.{0,24}?\b(tall|high|in height|long|height)\b/i;

const num = (s: string) => parseFloat(s.replace(',', '.'));
const toCm = (v: number, unit: string) => (/^m/i.test(unit) ? v / 10 : v);

type Measure = { lo: number; hi: number; at: number; isHeight: boolean };

function measures(sentence: string): Measure[] {
  const out: Measure[] = [];
  for (const m of sentence.matchAll(MEASURE)) {
    let lo: number, hi: number, unit: string;
    if (m[1] !== undefined) { unit = m[3]; lo = toCm(num(m[1]), unit); hi = toCm(num(m[2]), unit); }
    else if (m[4] !== undefined) { unit = m[5]; hi = toCm(num(m[4]), unit); lo = hi * 0.6; }
    else { unit = m[7]; hi = toCm(num(m[6]), unit); lo = hi; }
    if (!(hi > 0) || hi < lo) continue;
    const after = sentence.slice(m.index! + m[0].length);
    out.push({
      lo: Math.round(lo * 10) / 10,
      hi: Math.round(hi * 10) / 10,
      at: m.index!,
      isHeight: HEIGHT_HINT.test(after),
    });
  }
  return out;
}

/** "25-70 x 2-3.5 mm" / "3-9 x 5 cm": length first, width second, one trailing unit. */
// Mycological writing tacks parenthetical extremes onto a range: "2-3.5(-5) mm".
const EXTREME = String.raw`(?:\s*\(\s*[-–—]?\s*\d+(?:[.,]\d+)?\s*\))?`;
const UNIT = String.raw`(cm|mm|centimetres?|centimeters?|millimetres?|millimeters?)`;
const CROSS = new RegExp(
  String.raw`(\d+(?:[.,]\d+)?)\s*(?:[-–—]\s*(\d+(?:[.,]\d+)?))?` + EXTREME +
  String.raw`\s*[×x]\s*(\d+(?:[.,]\d+)?)\s*(?:[-–—]\s*(\d+(?:[.,]\d+)?))?` + EXTREME +
  String.raw`\s*` + UNIT + String.raw`\b`,
  'i',
);

function crossDims(sentence: string) {
  const m = sentence.match(CROSS);
  if (!m) return null;
  const u = m[5];
  const lo1 = toCm(num(m[1]), u);
  const hi1 = m[2] ? toCm(num(m[2]), u) : lo1;
  const lo2 = toCm(num(m[3]), u);
  const hi2 = m[4] ? toCm(num(m[4]), u) : lo2;
  const r = (v: number) => Math.round(v * 10) / 10;
  return { length: [r(lo1), r(hi1)] as [number, number], width: [r(lo2), r(hi2)] as [number, number] };
}

const positions = (sentence: string, re: RegExp) =>
  [...sentence.matchAll(re)].map((m) => m.index!);

const nearest = (pos: number[], at: number) =>
  pos.length ? Math.min(...pos.map((p) => Math.abs(p - at))) : Infinity;

/**
 * Attribute measurements in one sentence to cap vs stem by proximity, so
 * "cap 5-10 cm ... stipe 2-4 cm" splits correctly and a gill/spore measurement
 * sitting closer to "gills" is not mistaken for the cap.
 */
function attribute(sentence: string) {
  const cap = positions(sentence, CAP_WORDS);
  const stem = positions(sentence, STEM_WORDS);
  const other = positions(sentence, OTHER_WORDS);
  const capHits: Measure[] = [];
  const stemHits: Measure[] = [];
  for (const mm of measures(sentence)) {
    const dc = nearest(cap, mm.at);
    const ds = nearest(stem, mm.at);
    const dOther = nearest(other, mm.at);
    if (dOther < Math.min(dc, ds)) continue; // belongs to gills/spores/pores
    if (dc === Infinity && ds === Infinity) continue;
    (dc <= ds ? capHits : stemHits).push(mm);
  }
  return { capHits, stemHits };
}

const PLAUSIBLE = {
  cap: [0.2, 120] as [number, number],
  stem: [0.2, 60] as [number, number],
  stemWidth: [0.05, 20] as [number, number],
};
const ok = (m: Measure, k: keyof typeof PLAUSIBLE) =>
  m.lo >= PLAUSIBLE[k][0] && m.hi <= PLAUSIBLE[k][1];

/**
 * Walk the Description section first (where morphology lives), then the whole
 * article. First plausible attribution wins; its sentence is kept for provenance.
 */
function extractDims(text: string) {
  const clean = text.replace(/\s+/g, ' ');
  const descIdx = clean.search(/\bDescription\b/);
  const ordered = descIdx >= 0
    ? [clean.slice(descIdx), clean.slice(0, descIdx)]
    : [clean];

  let capCm: [number, number] | null = null;
  let stemCm: [number, number] | null = null;
  let stemWidthCm: [number, number] | null = null;
  let capSentence: string | null = null;
  let stemSentence: string | null = null;

  for (const part of ordered) {
    for (const sentence of part.split(/(?<=[.!?])\s+(?=[A-Z(])/)) {
      if (!/\d/.test(sentence)) continue;
      const { capHits, stemHits } = attribute(sentence);
      if (!capCm) {
        // a cap measurement is a diameter; skip ones the sentence marks as a height
        const hit = capHits.find((m) => ok(m, 'cap') && !m.isHeight);
        if (hit) { capCm = [hit.lo, hit.hi]; capSentence = sentence.trim(); }
      }
      if (!stemCm && STEM_WORDS.test(sentence)) {
        STEM_WORDS.lastIndex = 0; // global regex: reset after .test
        const cross = crossDims(sentence);
        if (cross && cross.length[0] >= PLAUSIBLE.stem[0] && cross.length[1] <= PLAUSIBLE.stem[1]) {
          stemCm = cross.length;
          stemSentence = sentence.trim();
          if (cross.width[1] <= PLAUSIBLE.stemWidth[1]) stemWidthCm = cross.width;
        }
      }
      STEM_WORDS.lastIndex = 0;
      if (!stemCm) {
        const all = stemHits.filter((m) => ok(m, 'stem'));
        // a stem measurement marked as a height is the one we want
        const plausible = [...all.filter((m) => m.isHeight), ...all.filter((m) => !m.isHeight)];
        if (plausible.length) {
          stemCm = [plausible[0].lo, plausible[0].hi];
          stemSentence = sentence.trim();
          // "5-20 cm high by 1-2 cm wide" -- the second measurement is the width
          const w = plausible[1];
          if (w && ok(w, 'stemWidth') && w.hi <= plausible[0].hi) stemWidthCm = [w.lo, w.hi];
        }
      }
      if (capCm && stemCm && stemWidthCm) break;
    }
    if (capCm && stemCm) break;
  }
  return { capCm, stemCm, stemWidthCm, capSentence, stemSentence };
}

const surfaceWord = (text: string, re: RegExp) => {
  for (const s of sentences(text)) {
    if (!/\b(cap|pileus)\b/i.test(s)) continue;
    if (re.test(s)) return s.trim();
  }
  return null;
};

/**
 * The template's `name` parameter is raw wikitext and carries whatever the editor
 * put beside the name: {{italic title}}, <ref>...</ref>, comments, markup.
 * Strip all of it or those end up displayed as part of the species name.
 */
function cleanName(raw: string | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/'{2,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * English names, so the search accepts "penny bun" as well as "Boletus edulis".
 * Taken from the article's opening sentence, which states them in a few fixed
 * forms: "commonly known as the X, Y, or Z", "(English: X, Y)", ", the X,".
 */
const NAME_PATTERNS = [
  /(?:commonly|popularly|variously|generally|also|otherwise)?\s*(?:known|called|referred to)\s+as\s+(?:the\s+)?([^.]{2,160}?)(?:,\s*(?:is|are|it)\b|\s+(?:is|are)\b|\.)/i,
  /\(\s*English\s*:\s*([^)]{2,120})\)/i,
  /^[A-Z][a-z]+ [a-z-]+,\s+the\s+([^,]{2,60}),\s+is\b/,
];
/**
 * Prose fragments rather than names. "fungus" and "mushroom" are deliberately NOT
 * rejected outright -- "bearded tooth fungus" and "oyster mushroom" are real common
 * names -- only phrases that are purely generic or clearly sentence material.
 */
const GENERIC_ONLY = /^(?:a |an |the )?(?:species|genus|family|fungus|fungi|mushroom|toadstool|agaric)$/i;
const NOT_A_NAME = /\b(species|genus|basidiomycete|ascomycete|member|synonym|which|that|this|its|known|found|called)\b|\d/i;
/** Adverbs that lead a name in a list: "or simply red toadstool". */
const LEADING_FILLER = /^(?:simply|just|sometimes|often|usually|variously|commonly|popularly|more |most )\s*/i;

function commonNames(desc: string, title: string): string[] {
  const opening = desc.replace(/\s+/g, ' ').split(/(?<=\.)\s+(?=[A-Z])/).slice(0, 3).join(' ');
  const out = new Set<string>();
  for (const re of NAME_PATTERNS) {
    const m = opening.match(re);
    if (!m) continue;
    for (const part of m[1].split(/\s*(?:,|;|\bor\b|\band\b)\s*/)) {
      const name = part
        .replace(/["\u201c\u201d()]/g, '')      // quotes and brackets, but keep apostrophes
        .replace(/^the\s+/i, '')
        .replace(LEADING_FILLER, '')
        .trim()
        .toLowerCase();
      if (name.length < 3 || name.length > 40) continue;
      if (GENERIC_ONLY.test(name) || NOT_A_NAME.test(name)) continue;
      if (!/^[a-z][a-z'\u2019 -]+$/.test(name)) continue;
      out.add(name);
    }
    if (out.size) break; // first pattern that yields anything wins
  }
  // a page titled in English rather than Latin is itself a common name
  if (!/^[A-Z][a-z]+ [a-z-]+$/.test(title)) out.add(title.toLowerCase());
  return [...out].slice(0, 6);
}

// ---------------------------------------------------------------- main

async function main() {
  console.log('1/5 listing Mycomorphbox transclusions...');
  const all = await candidateTitles();
  const species = all.filter(isBinomial);
  console.log(`    ${all.length} pages, ${species.length} binomials`);

  console.log('2/5 fetching 12-month pageviews (resumable, cached)...');
  for (let pass = 1; pass <= 8; pass++) {
    const todo = species.filter((t) => !(t in cache));
    if (!todo.length) break;
    console.log(`    pass ${pass}: ${todo.length} remaining`);
    let done = 0;
    await pool(todo, 3, async (t) => {
      await pageviews(t);
      if (++done % 50 === 0) {
        writeFileSync(CACHE, JSON.stringify(cache)); // persist as we go, not at the end
        process.stdout.write(`    ${done}/${todo.length}\r`);
      }
    });
    writeFileSync(CACHE, JSON.stringify(cache));
    if (species.some((t) => !(t in cache))) await sleep(20000);
  }
  writeFileSync(CACHE, JSON.stringify(cache));
  const unresolved = species.filter((t) => !(t in cache));
  if (unresolved.length) console.warn(`    WARN ${unresolved.length} titles unresolved, treated as 0`);
  const views = species.map((t) => ({ title: t, views: cache[t] ?? 0 }));
  views.sort((a, b) => b.views - a.views);
  const TARGET = Number(process.env.SPECIES_COUNT ?? 1000);
  const top = views.slice(0, TARGET);
  console.log(`\n    top: ${top.slice(0, 5).map((t) => `${t.title} (${t.views})`).join(', ')}`);

  console.log(`3/5 fetching wikitext for ${top.length} species (batched)...`);
  const wikitext = new Map<string, { text: string; revid: number }>();
  for (const batch of chunk(top.map((t) => t.title), 50)) {
    const data = await getJSON(
      q({
        action: 'query', prop: 'revisions', rvprop: 'ids|content', rvslots: 'main',
        titles: batch.join('|'),
      }),
    );
    for (const p of data.query.pages) {
      const rev = p.revisions?.[0];
      if (rev) wikitext.set(p.title, { text: rev.slots.main.content, revid: rev.revid });
    }
  }

  console.log('4/5 fetching images + full extracts...');
  const meta = new Map<string, any>();
  for (const batch of chunk(top.map((t) => t.title), 20)) {
    const data = await getJSON(
      q({
        action: 'query', prop: 'pageimages|pageprops', piprop: 'original|name',
        titles: batch.join('|'),
      }),
    );
    for (const p of data.query.pages) meta.set(p.title, p);
  }
  let edone = 0;
  await pool(top.map((t) => t.title), 4, async (t) => {
    await fullExtract(t);
    if (++edone % 20 === 0) writeFileSync(ECACHE, JSON.stringify(extracts));
  });
  writeFileSync(ECACHE, JSON.stringify(extracts));

  console.log('5/5 fetching image licences...');
  const fileTitles = [...meta.values()].map((p) => p.pageimage).filter(Boolean).map((n) => `File:${n}`);
  const licences = new Map<string, { artist: string; license: string; page: string }>();
  for (const batch of chunk(fileTitles, 50)) {
    const data = await getJSON(
      q({ action: 'query', prop: 'imageinfo', iiprop: 'extmetadata|url', titles: batch.join('|') }),
    );
    for (const p of data.query.pages ?? []) {
      const em = p.imageinfo?.[0]?.extmetadata;
      if (!em) continue;
      licences.set(p.title.replace(/_/g, ' '), {
        artist: cleanArtist(em.Artist?.value),
        license: em.LicenseShortName?.value ?? 'see Commons',
        page: httpsOnly(p.imageinfo?.[0]?.descriptionurl)
          ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}`,
      });
    }
  }

  // ---- extra photos for the per-species slideshow ----
  console.log('6/6 fetching gallery images...');
  const GCACHE = 'scripts/.cache-gallery.json';
  const gcache: { files?: Record<string, string[]>; info?: Record<string, any> } =
    existsSync(GCACHE) ? JSON.parse(readFileSync(GCACHE, 'utf8')) : {};
  const JUNK = /(commons-logo|question_book|wiki\w*-logo|edit-|ambox|symbol|flag_|map_|loudspeaker|disambig|increase2?|decrease2?|star_|padlock|information_icon|red_pencil|translation_to)/i;
  const isPhoto = (f: string) => /\.(jpe?g|png|tiff?)$/i.test(f) && !JUNK.test(f);

  /**
   * imlimit caps the whole response, not each page, so a batch of titles returns
   * a truncated list plus a continuation token. Without following it only the
   * first few pages get any images at all.
   */
  const pageFiles = new Map<string, string[]>(Object.entries(gcache.files ?? {}));
  let gdone = 0;
  const needFiles = top.map((t) => t.title).filter((t) => !pageFiles.has(t));
  for (const batch of chunk(needFiles, 20)) {
    let cont: string | undefined;
    do {
      const data: any = await getJSON(
        q({
          action: 'query', prop: 'images', imlimit: 'max', titles: batch.join('|'),
          ...(cont ? { imcontinue: cont } : {}),
        }),
      );
      for (const pg of data.query.pages ?? []) {
        const names = (pg.images ?? []).map((i: any) => i.title).filter(isPhoto);
        pageFiles.set(pg.title, [...(pageFiles.get(pg.title) ?? []), ...names]);
      }
      cont = data.continue?.imcontinue;
    } while (cont);
    gdone += batch.length;
    if (gdone % 200 === 0) {
      writeFileSync(GCACHE, JSON.stringify({ files: Object.fromEntries(pageFiles), info: gcache.info }));
      process.stdout.write(`    ${gdone}/${needFiles.length}\r`);
    }
  }
  writeFileSync(GCACHE, JSON.stringify({ files: Object.fromEntries(pageFiles), info: gcache.info }));

  /**
   * Articles embed images of related species and cultural material -- Amanita
   * muscaria's page carries a 4th-century mosaic and a photo of Amanita crocea,
   * a different mushroom. Showing those in a species gallery is misleading, so
   * a file must name this species, and must not name a different one.
   */
  const epithetsByGenus = new Map<string, Set<string>>();
  for (const t of top) {
    const [g, e] = t.title.toLowerCase().split(' ');
    if (!e) continue;
    if (!epithetsByGenus.has(g)) epithetsByGenus.set(g, new Set());
    epithetsByGenus.get(g)!.add(e);
  }

  /** Higher is a better match for this species; null means reject outright. */
  function relevance(file: string, title: string): number | null {
    const name = decodeURIComponent(file.split('?')[0].split('/').pop() ?? file)
      .replace(/^File:/i, '').replace(/^\d+px-/, '')
      .replace(/[_-]+/g, ' ').toLowerCase();
    const [genus, epithet] = title.toLowerCase().split(' ');
    if (!epithet) return name.includes(genus) ? 1 : null;

    const namesThis = name.includes(`${genus} ${epithet}`) || name.includes(epithet);
    // a different species of the same genus, named in the filename. Allowed only
    // if this species is named too -- "morchella elata spitzmorchel morchella
    // conica.jpg" is a picture of elata that also mentions a synonym.
    if (!namesThis) {
      for (const other of epithetsByGenus.get(genus) ?? []) {
        if (other !== epithet && name.includes(`${genus} ${other}`)) return null;
      }
    }
    if (name.includes(`${genus} ${epithet}`)) return 3;
    if (name.includes(epithet)) return 2;
    if (name.includes(genus)) return 1;
    return null; // names neither the genus nor the species
  }

  /**
   * Wikipedia's own lead image is trusted unless its filename explicitly names a
   * different species -- two articles lead with a photo of another mushroom.
   * An uninformative filename ("DSC_1234.jpg") is fine: an editor chose it for
   * this article, and rejecting those cost 100 species their photo.
   */
  function leadIsValid(url: string | undefined, title: string): boolean {
    if (!url) return true;
    const name = decodeURIComponent(url.split('?')[0].split('/').pop() ?? '')
      .replace(/^\d+px-/, '').replace(/[_-]+/g, ' ').toLowerCase();
    const [genus, epithet] = title.toLowerCase().split(' ');
    if (!epithet) return true;
    if (name.includes(`${genus} ${epithet}`) || name.includes(epithet)) return true;
    for (const other of epithetsByGenus.get(genus) ?? []) {
      if (other !== epithet && name.includes(`${genus} ${other}`)) return false;
    }
    return true;
  }

  for (const [title, files] of pageFiles) {
    pageFiles.set(title, files
      .map((f) => ({ f, r: relevance(f, title) }))
      .filter((x): x is { f: string; r: number } => x.r !== null)
      .sort((a, b) => b.r - a.r)
      .map((x) => x.f));
  }

  const wanted = [...new Set([...pageFiles.values()].flat())];
  console.log(`    ${wanted.length} candidate files`);
  const fileInfo = new Map<string, { url: string; artist: string; license: string; page: string }>(
    Object.entries(gcache.info ?? {}),
  );
  let fdone = 0;
  for (const batch of chunk(wanted.filter((w) => !fileInfo.has(w.replace(/_/g, ' '))), 50)) {
    const data = await getJSON(
      q({
        action: 'query', prop: 'imageinfo', iiprop: 'url|extmetadata|mime',
        iiurlwidth: '960', titles: batch.join('|'),
      }),
    );
    for (const pg of data.query.pages ?? []) {
      const info = pg.imageinfo?.[0];
      if (!info || !/^image\//.test(info.mime ?? '')) continue;
      const em = info.extmetadata ?? {};
      fileInfo.set(pg.title.replace(/_/g, ' '), {
        url: httpsOnly(info.thumburl) ?? httpsOnly(info.url) ?? '',
        artist: cleanArtist(em.Artist?.value),
        license: em.LicenseShortName?.value ?? 'see Commons',
        // the Commons file page carries the full author, licence and source
        page: httpsOnly(info.descriptionurl)
          ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(pg.title)}`,
      });
    }
    fdone += batch.length;
    if (fdone % 500 === 0) process.stdout.write(`    ${fdone}/${wanted.length}\r`);
  }
  writeFileSync(GCACHE, JSON.stringify({
    files: Object.fromEntries(pageFiles), info: Object.fromEntries(fileInfo),
  }));
  console.log(`    resolved ${fileInfo.size} images`);

  const records = top.map(({ title, views }) => {
    const wt = wikitext.get(title);
    const m = meta.get(title) ?? {};
    const box = wt ? parseMycomorphbox(wt.text) : {};
    const desc: string = extracts[title] ?? '';

    const dims = extractDims(desc);

    const file = m.pageimage ? `File:${m.pageimage}` : null;
    const lic = file ? licences.get(file.replace(/_/g, ' ')) : undefined;

    return {
      name: title,
      views,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
      revid: wt?.revid ?? null,
      wikidata: m.pageprops?.wikibase_item ?? null,
      sciName: cleanName(box.name) || title,
      common: commonNames(desc, title),
      box: {
        capShape: multi(box, 'capShape'),
        hymenium: multi(box, 'hymeniumType'),
        whichGills: multi(box, 'whichGills'),
        stipe: multi(box, 'stipeCharacter'),
        sporePrint: multi(box, 'sporePrintColor'),
        ecology: multi(box, 'ecologicalType'),
        edibility: multi(box, 'howEdible'),
      },
      where: extractHabitat(desc),
      capCm: dims.capCm,
      stemCm: dims.stemCm,
      stemWidthCm: dims.stemWidthCm,
      wartsSentence: surfaceWord(desc, /\bwarts?\b|\bwarty\b|verruc|\bpatches\b/i),
      hasRidges: /\bridge|\bwrinkl|\bfold/i.test(desc),
      scalesSentence: surfaceWord(desc, /\bscal(?:e|es|y)\b|squamul|fibrillose/i),
      image: httpsOnly(m.original?.source) && leadIsValid(m.original.source, title)
        ? {
            url: m.original.source, file,
            artist: lic?.artist ?? 'unknown',
            license: lic?.license ?? 'see Commons',
            page: lic?.page ?? (file ? `https://commons.wikimedia.org/wiki/${encodeURIComponent(file)}` : ''),
          }
        : null,
      gallery: (pageFiles.get(title) ?? [])
        .map((f) => ({ file: f, ...fileInfo.get(f.replace(/_/g, ' ')) }))
        .filter((g): g is { file: string; url: string; artist: string; license: string; page: string } => Boolean(g.url))
        .slice(0, 6),
      autoCapColor: extractColor(desc, 'cap'),
      autoStemColor: extractColor(desc, 'stem'),
      provenance: { capSentence: dims.capSentence, stemSentence: dims.stemSentence },
      description: desc.slice(0, 20000),
    };
  });

  writeFileSync('src/data/species.raw.json', JSON.stringify(records, null, 2));

  // ---- merge with the hand-derived colour table into the runtime file ----
  const COLORS = 'src/data/species.colors.json';
  if (existsSync(COLORS)) {
    const colors = JSON.parse(readFileSync(COLORS, 'utf8'));
    /** stipeCharacter is a single phrase ("ring and volva"); the matcher wants a set. */
    /** Mycomorphbox is hand-edited, so singulars and typos slip in. */
    const HYMENIUM_ALIAS: Record<string, string> = {
      pore: 'pores', gill: 'gills', tooth: 'teeth', spine: 'teeth', spines: 'teeth',
      ridge: 'ridges', wrinkle: 'ridges', wrinkles: 'ridges', glebal: 'gleba',
    };
    const HYMENIA = new Set(['gills', 'pores', 'teeth', 'ridges', 'smooth', 'gleba']);
    const normHymenium = (v: string | undefined) => {
      if (!v) return null;
      const n = HYMENIUM_ALIAS[v] ?? v;
      return HYMENIA.has(n) ? n : null;
    };

    /**
     * Gill attachment, folded onto the five forms the 3D model can draw.
     * Unrecognised values are dropped rather than passed through -- one article
     * had "67" in this field, which would otherwise be scored as a real trait.
     */
    const ATTACH_ALIAS: Record<string, string> = {
      free: 'free', adnexed: 'adnexed', adnate: 'adnate',
      sinuate: 'sinuate', emarginate: 'sinuate', notched: 'sinuate',
      decurrent: 'decurrent', subdecurrent: 'decurrent',
      seceding: 'free', // seceding gills pull away from the stem
    };
    const normAttach = (v: string | undefined) => (v ? ATTACH_ALIAS[v] ?? null : null);

    const stipeSet = (vals: string[]) => {
      const out = new Set<string>();
      for (const v of vals) for (const w of v.split(/\s+and\s+/)) if (w && w !== 'bare') out.add(w.trim());
      return [...out];
    };
    const runtime = records.map((r) => {
      // A species present in species.colors.json was read by hand, and that
      // verdict is final -- including a deliberate null, which means "the article
      // does not state a colour". Letting auto-extraction fill those back in
      // would silently overturn the curation.
      const curated = Object.prototype.hasOwnProperty.call(colors, r.name);
      const c = colors[r.name] ?? {};
      const capColor = curated ? c.capColor ?? null : r.autoCapColor?.hex ?? null;
      const stemColor = curated ? c.stemColor ?? null : r.autoStemColor?.hex ?? null;
      const colorMethod = curated ? (c.capColor ? 'manual' : null) : r.autoCapColor ? 'auto' : null;
      return {
        name: r.sciName,
        page: r.name,
        common: r.common,
        views: r.views,
        url: r.url,
        revid: r.revid,
        wikidata: r.wikidata,
        capShape: r.box.capShape,
        hymenium: normHymenium(r.box.hymenium[0]),
        gillAttachment: normAttach(r.box.whichGills[0]),
        stipe: stipeSet(r.box.stipe),
        sporePrint: r.box.sporePrint,
        ecology: r.box.ecology[0] ?? null,
        edibility: r.box.edibility,
        capCm: r.capCm,
        stemCm: r.stemCm,
        stemWidthCm: r.stemWidthCm,
        capColor,
        capColorName: curated ? c.capColorName ?? null : r.autoCapColor?.name ?? null,
        stemColor,
        colorMethod,
        season: r.where.season,
        regions: r.where.regions,
        habitat: r.where.habitat,
        hasWarts: Boolean(r.wartsSentence),
        hasScales: Boolean(r.scalesSentence),
        // the API appends ?utm_... tracking parameters; they are ~80 KB of nothing
        image: r.image ? { ...r.image, url: r.image.url.split('?')[0], artist: cleanArtist(r.image.artist) } : null,
      };
    });
    writeFileSync('src/data/species.json', JSON.stringify(runtime));

    /**
     * Photos live in their own file, loaded only when someone opens a slideshow.
     * Inlining six images per species would roughly double the initial download
     * for something most visitors never open.
     */
    const gallery: Record<string, { url: string; artist: string; license: string; page: string }[]> = {};
    for (const r of records) {
      const shots: { url: string; artist: string; license: string; page: string }[] = [];
      const seen = new Set<string>();
      for (const g of [
        ...(r.image ? [{ url: r.image.url, artist: cleanArtist(r.image.artist), license: r.image.license, page: r.image.page }] : []),
        ...r.gallery.map((g) => ({ url: g.url, artist: cleanArtist(g.artist), license: g.license, page: g.page })),
      ]) {
        // Commons redirects renamed files, so a photo filed as "Trametes
        // ochracea ...jpg" can resolve to "Trametes versicolor ...jpg" after a
        // re-identification. Check the URL we actually ended up with, not the
        // name we asked for.
        if (!leadIsValid(g.url, r.name)) continue;
        // the same photo appears as a full-size URL and as a thumbnail; strip
        // the query string and the "960px-" prefix so they collapse to one key
        const key = decodeURIComponent(g.url.split('?')[0].split('/').pop()!)
          .replace(/^\d+px-/, '')
          .toLowerCase();
        if (seen.has(key)) continue; // the lead photo is usually in the list too
        seen.add(key);
        shots.push({ ...g, url: g.url.split('?')[0] });
        if (shots.length === 5) break;
      }
      if (shots.length) gallery[r.sciName] = shots;
    }
    // public/ is copied verbatim into dist. A dynamically imported JSON module
    // is NOT emitted as an asset by Vite, so the slideshow 404'd in production
    // while working fine in dev.
    writeFileSync('public/gallery.json', JSON.stringify(gallery));
    const counts = Object.values(gallery).map((g) => g.length);
    console.log(`gallery: ${counts.length} species, ${counts.reduce((a, b) => a + b, 0)} photos, ` +
      `${counts.filter((c) => c >= 3).length} with 3+`);
    const byMethod = (m: string | null) => runtime.filter((x) => x.colorMethod === m).length;
    console.log(`merged ${runtime.length} -> src/data/species.json`);
    console.log(`  cap colour: ${byMethod('manual')} hand-derived, ${byMethod('auto')} auto, ${byMethod(null)} none`);
  } else {
    console.log('no species.colors.json yet -- skipping merge');
  }
  const miss = (f: (r: any) => boolean) => records.filter(f).length;
  console.log(`\nwrote ${records.length} species to src/data/species.raw.json`);
  console.log(`  no hymenium: ${miss((r) => !r.box.hymenium.length)}`);
  console.log(`  no capCm:    ${miss((r) => !r.capCm)}`);
  console.log(`  no stemCm:   ${miss((r) => !r.stemCm)}`);
  console.log(`  no image:    ${miss((r) => !r.image)}`);
}

main();
