/**
 * Deterministic cap/stem colour extraction from Wikipedia description prose.
 *
 * The first 100 species have hand-derived colours in species.colors.json and those
 * stay authoritative. This covers the long tail, where reading every article by
 * hand is not practical. Every value records the sentence it came from and is
 * marked `auto`, so the two sources are never confused.
 */

/** Base colour vocabulary as used in mycological description writing. */
const BASE: Record<string, string> = {
  white: '#f2ece0', whitish: '#efe8da', cream: '#efe6d0', creamy: '#efe6d0', ivory: '#f2ead8',
  buff: '#ddd0b0', tan: '#c9a877', beige: '#d8c8ad', straw: '#ddc98b', pallid: '#ece5d6',
  brown: '#8a5a2b', chestnut: '#7a3f22', chocolate: '#4a2f20', cinnamon: '#a9602c',
  ochre: '#c08a2e', ochraceous: '#c08a2e', ocher: '#c08a2e', ochie: '#c08a2e',
  tawny: '#b06a20', umber: '#5a4330', fawn: '#b08a68', hazel: '#9a6a3a', caramel: '#b5793c',
  bistre: '#4a3225', fuscous: '#5a4a3a', date: '#6a4a32', clay: '#b09070', honey: '#d8a848',
  red: '#c8201a', scarlet: '#d81f2a', crimson: '#b81030', vinaceous: '#9a5a5a',
  maroon: '#6a2028', rust: '#9a4a1a', rusty: '#9a4a1a', copper: '#a85a28', brick: '#9a4030',
  orange: '#e07a1e', apricot: '#e8a060', salmon: '#e8a080', tangerine: '#e8801a',
  yellow: '#e2c42a', golden: '#e0a81e', gold: '#e0a81e', lemon: '#e8d83a',
  sulphur: '#e8d040', sulfur: '#e8d040', saffron: '#e8a820', amber: '#d89a28',
  olive: '#6a6a2e', olivaceous: '#6a6a2e', green: '#4a7a3a', greenish: '#5a7a4a', verdigris: '#4a8a70',
  blue: '#3a56a0', azure: '#2a6ba8', indigo: '#33478f', bluish: '#4a66a8',
  violet: '#6a3a8a', purple: '#5a2a6a', lilac: '#a88ac0', mauve: '#a080a8',
  burgundy: '#6a2030', amethyst: '#8a5aa8',
  pink: '#d8a0a0', rose: '#d88a92', flesh: '#e0bfae', pinkish: '#d8a8a8',
  grey: '#8a8580', gray: '#8a8580', slate: '#5a6068', ash: '#9a9690', smoky: '#6a6560',
  black: '#221f1d', blackish: '#2e2a26', sepia: '#4a3a2a', liver: '#6a3a30', sooty: '#2e2b28',
};

/** Words that shift lightness or saturation rather than naming a hue. */
const LIGHTEN: Record<string, number> = { pale: 0.34, light: 0.28, paler: 0.3, faint: 0.3, dull: 0.12, washed: 0.25 };
const DARKEN: Record<string, number> = { dark: 0.3, deep: 0.26, darker: 0.3, blackish: 0.42, dusky: 0.28, sombre: 0.25 };

const hex2rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgb2hex = (c: number[]) =>
  '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const mix = (a: string, b: string, t: number) => {
  const [r1, g1, b1] = hex2rgb(a);
  const [r2, g2, b2] = hex2rgb(b);
  return rgb2hex([r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t]);
};

/** "brownish" -> "brown", "yellowish" -> "yellow". */
function normalise(word: string): string | null {
  const w = word.toLowerCase().replace(/[^a-z-]/g, '');
  if (BASE[w]) return w;
  const stripped = w.replace(/ish$/, '');
  if (BASE[stripped]) return stripped;
  // "yellowy", "greyer"
  const s2 = w.replace(/(y|er|est)$/, '');
  return BASE[s2] ? s2 : null;
}

/**
 * Turn a colour phrase into a hex value. In English compounds the LAST term is
 * the base hue and earlier terms tint it ("yellow-brown" is a brown), so the
 * head of the compound is weighted accordingly.
 */
export function phraseToHex(phrase: string): { hex: string; name: string } | null {
  const tokens = phrase.toLowerCase().split(/[\s-]+/).filter(Boolean);
  const hues: string[] = [];
  let light = 0;
  let dark = 0;
  for (const t of tokens) {
    const base = normalise(t);
    if (base) { hues.push(base); continue; }
    const w = t.replace(/[^a-z]/g, '');
    if (LIGHTEN[w]) light = Math.max(light, LIGHTEN[w]);
    if (DARKEN[w]) dark = Math.max(dark, DARKEN[w]);
  }
  if (!hues.length) return null;
  const baseHue = hues[hues.length - 1];
  let hex = BASE[baseHue];
  // tint toward the earlier terms, weighted below the base
  for (const tint of hues.slice(0, -1)) hex = mix(hex, BASE[tint], 0.34);
  if (light) hex = mix(hex, '#ffffff', light);
  if (dark) hex = mix(hex, '#1b1714', dark);
  return { hex, name: hues.join('-') };
}

const COLOUR_WORDS = [...Object.keys(BASE), ...Object.keys(LIGHTEN), ...Object.keys(DARKEN)]
  .sort((a, b) => b.length - a.length)
  .join('|');
/** One colour phrase: "brown", "pale yellowish-brown", "dark olive brown". */
const PHRASE = `(?:${COLOUR_WORDS})\\w*(?:[-\\s]+(?:${COLOUR_WORDS})\\w*){0,3}`;
const SUBJ = {
  cap: '(?:caps?|pileus|pilei|fruit ?bodies|fruit ?body|fruiting bod(?:y|ies)|basidiocarps?)',
  stem: '(?:stipes?|stems?|stalks?)',
};

/**
 * Only two phrasings are trusted, because only they bind a colour to a part
 * unambiguously:
 *   A  "the bright red cap ..."      colour immediately before the noun
 *   B  "the cap is bright red ..."   noun, copula, then colour
 * Everything looser ("fruiting bodies emerge looking like white eggs",
 * "red fluid exudes from the cap") produced wrong answers often enough that
 * guessing is worse than saying nothing -- the matcher simply skips a null.
 */
const patterns = (part: 'cap' | 'stem') => [
  new RegExp(`\\b(${PHRASE})[\\s-]+${SUBJ[part]}\\b`, 'i'),
  new RegExp(`\\b${SUBJ[part]}\\b[^.;]{0,24}?\\b(?:is|are|was|were|becomes?|turns?|appears?|colou?red|colou?r is)\\b[^.;]{0,14}?\\b(${PHRASE})`, 'i'),
];

/** Sentences describing something other than the mature colour of the part. */
const DISQUALIFY =
  /\b(egg|eggs|immature|young|button stage|unexpanded|primordi\w*|stain\w*|bruis\w*|damag\w*|injur\w*|oxidis\w*|oxidiz\w*|spore print|similar species|unlike|distinguish\w*|confus\w*|resembl\w*|mistaken|compare[sd]?|microscop\w*|reagent|KOH)\b/i;

/** Words naming a different structure; if one sits inside the match it is not ours. */
const OTHER =
  /\b(gills?|lamellae?|spores?|pores?|tubes?|teeth|spines?|flesh|mycelium|latex|milk|fluid|juice|rings?|volvas?|warts?|scales?|margin|veil|cortina|rhizomorphs?)\b/i;

const sentences = (t: string) => t.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z(])/);

export function extractColor(
  text: string, part: 'cap' | 'stem',
  opts: { patterns?: 0 | 1 | 2; descriptionOnly?: boolean } = {},
) {
  const clean = text.replace(/\s+/g, ' ');
  const descIdx = clean.search(/\bDescription\b/);
  // the Description section first; it is where morphology is actually stated
  const ordered = descIdx >= 0
    ? (opts.descriptionOnly ? [clean.slice(descIdx)] : [clean.slice(descIdx), clean.slice(0, descIdx)])
    : (opts.descriptionOnly ? [] : [clean]);
  const all = patterns(part);
  const pats = opts.patterns === undefined ? all : all.slice(0, opts.patterns || all.length);

  for (const chunk of ordered) {
    for (const s of sentences(chunk)) {
      if (DISQUALIFY.test(s)) continue;
      for (const re of pats) {
        const m = s.match(re);
        if (!m) continue;
        if (OTHER.test(m[0])) continue; // the phrase belongs to another structure
        const hit = phraseToHex(m[1]);
        if (hit) return { ...hit, sentence: s.trim().slice(0, 240) };
      }
    }
  }
  return null;
}
