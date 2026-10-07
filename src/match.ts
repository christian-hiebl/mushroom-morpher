/**
 * Scores the user's mushroom against the 100 real species in species.json.
 *
 * Every trait contributes a similarity in [0,1] times a weight. Traits the species
 * has no data for are credited at a neutral PRIOR rather than dropped, and the
 * denominator is always the full applicable weight. That matters: dropping them
 * instead lets a species with almost nothing recorded about it (Claviceps purpurea
 * has no hymenium, cap shape, colour or dimensions) score ~100% off two lucky
 * traits. Crediting the unknowns neutrally means a sparse record simply cannot
 * reach the top -- we do not know enough about it to claim a strong match.
 */
import type { Ecology, GillAttachment, Hymenium, MushroomParams } from './params';
import { ATTACHMENTS, DEFAULTS, HYMENIA, SHAPE_AXIS, clamp } from './params';

export type Species = {
  name: string;
  page: string;
  /** English names from the article's opening sentence, for searching. */
  common: string[];
  /** 12-month Wikipedia pageviews, used only to break near-ties. */
  views: number;
  url: string;
  revid: number | null;
  wikidata: string | null;
  capShape: string[];
  hymenium: string | null;
  gillAttachment: string | null;
  stipe: string[];
  sporePrint: string[];
  ecology: string | null;
  edibility: string[];
  capCm: [number, number] | null;
  stemCm: [number, number] | null;
  stemWidthCm: [number, number] | null;
  capColor: string | null;
  capColorName: string | null;
  stemColor: string | null;
  /** How the colour was derived: hand-read from the article, or auto-extracted. */
  colorMethod: 'manual' | 'auto' | null;
  hasWarts: boolean;
  hasScales: boolean;
  image: {
    url: string; file: string | null; artist: string; license: string;
    /** Commons file page, carrying the full author / licence / source. */
    page: string;
  } | null;
};

export type TraitScore = { label: string; sim: number; detail: string };
export type Match = {
  species: Species;
  /** Match quality over the traits the article actually records, 0-100. */
  score: number;
  traits: TraitScore[];
  /** Weight of traits that could be scored, and of those that could apply. */
  known: number;
  applicable: number;
};

// ---------------------------------------------------------------- colour distance

/** sRGB hex -> CIE L*a*b* (D65). Needed because raw RGB distance ranks dark red ~ black. */
function toLab(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const srgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = srgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const [r, g, b] = lin;
  // sRGB -> XYZ, then normalise by the D65 white point
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76. ~60 counts as "completely different" for ranking purposes. */
export function colorSim(a: string, b: string): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  const dE = Math.hypot(l1 - l2, a1 - a2, b1 - b2);
  return Math.max(0, 1 - dE / 60);
}

// ---------------------------------------------------------------- trait similarity

/** 1 inside the recorded range, tapering outside it. Tight ranges are stricter. */
export function rangeSim(v: number, range: [number, number]): number {
  const [lo, hi] = range;
  if (v >= lo && v <= hi) return 1;
  const d = v < lo ? lo - v : v - hi;
  const span = Math.max(hi - lo, 1);
  return Math.max(0, 1 - d / (span * 1.5));
}

/** Gill attachment placed on one free..decurrent axis for graded similarity. */
const ATTACH_AXIS: Record<string, number> = {
  free: 0,
  adnexed: 0.25,
  adnate: 0.5,
  emarginate: 0.6,
  sinuate: 0.6,
  subdecurrent: 0.85,
  decurrent: 1,
};

/** Overlap of {ring, volva} between user and species. */
function stipeSim(params: MushroomParams, stipe: string[]): number {
  const want = new Set<string>();
  if (params.ring) want.add('ring');
  if (params.volva) want.add('volva');
  const has = new Set<string>(stipe.filter((s) => s === 'ring' || s === 'volva'));
  if (!want.size && !has.size) return 1; // both bare
  const inter = [...want].filter((w) => has.has(w)).length;
  const union = new Set([...want, ...has]).size;
  return inter / union;
}

/** Best match across every cap shape the species lists. */
function shapeSim(curve: number, shapes: string[]): number | null {
  const on = shapes.map((s) => SHAPE_AXIS[s]).filter((v): v is number => v !== undefined);
  if (!on.length) return null; // e.g. only "offset", which is not on this axis
  return Math.max(...on.map((v) => Math.max(0, 1 - Math.abs(curve - v) / 2)));
}

// ---------------------------------------------------------------- scoring

/**
 * Minimum weight of scorable traits for a species to be rankable at all.
 *
 * This replaces an earlier scheme that credited unknown traits at a neutral
 * prior. That scheme had a fatal flaw: a species could never match its own
 * model. Podaxis pistillaris records only four traits, matched all four
 * perfectly, and still scored 74.6% -- losing to well-documented species that
 * merely resembled the fallback shape. Being poorly documented was itself a
 * penalty, which is wrong: the score answers "how well does this fit what we
 * know", not "how much do we know".
 *
 * Sparse records are instead handled two ways: anything below this floor is
 * excluded outright (Claviceps purpurea knows nothing but stem and warts, and
 * used to score ~100% off those two), and coverage is reported alongside the
 * score so a 100% from three traits is never mistaken for a 100% from nine.
 */
const MIN_EVIDENCE = 5.5;

/**
 * Auto-extracted colours are right about three times in four, measured against
 * the 100 hand-derived ones, so they carry proportionally less weight.
 *
 * This must be a weight reduction, not a shrink of the similarity itself. An
 * earlier version pulled the similarity toward neutral, which capped a *correct*
 * auto colour at 0.775 and meant 293 species could not match their own recorded
 * colour. Low confidence should mean "counts for less", never "cannot be right".
 */
const AUTO_COLOR_WEIGHT = 0.55;

/** The dimensions a match can be scored on. */
export type TraitKey =
  | 'hymenium' | 'stipe' | 'capShape' | 'capColor' | 'gillAttachment'
  | 'capDiameter' | 'stemHeight' | 'stemWidth' | 'warts' | 'scales'
  | 'sporePrint' | 'ecology';

const WEIGHTS = {
  hymenium: 3, // the strongest real identification signal
  stipe: 2,
  capShape: 1.5,
  capColor: 1.5,
  gillAttachment: 1,
  capDiameter: 1,
  stemHeight: 1,
  stemWidth: 1,
  warts: 1,
  scales: 1,
  // a classic identification character, and the strongest trait left once shape
  // and colour agree: it separates Podaxis (buff) from the black-spored inkcaps
  sporePrint: 2,
  ecology: 1,
};

/**
 * Spore print names are compound ("purple-brown"), so related prints should be
 * partially similar rather than simply unequal. Token overlap does that without
 * needing yet another colour table.
 */
function sporeSim(want: string, have: string[]): number {
  const a = new Set(want.split('-'));
  return Math.max(...have.map((h) => {
    const b = new Set(h.split('-'));
    const inter = [...a].filter((t) => b.has(t)).length;
    return inter / new Set([...a, ...b]).size;
  }));
}

/**
 * Total weight in play for a given user configuration. Independent of the species
 * so scores stay comparable across them, and a complete match can reach 100%.
 */
/** Upper bound on scorable weight for these params; mirrors score()'s choices. */
function applicableWeight(params: MushroomParams, skip?: ReadonlySet<TraitKey>): number {
  const keys: TraitKey[] = ['hymenium', 'stipe', 'capShape', 'capColor',
    'capDiameter', 'stemHeight', 'stemWidth', 'warts', 'scales'];
  if (params.hymenium === 'gills') keys.push('gillAttachment');
  if (params.sporePrint) keys.push('sporePrint');
  if (params.ecology) keys.push('ecology');
  return keys.filter((k) => !skip?.has(k)).reduce((t, k) => t + WEIGHTS[k], 0);
}

/**
 * `skip` removes a trait from scoring entirely, for every species.
 *
 * It exists because building a species whose article records no size leaves the
 * model holding default dimensions. Those defaults are not a choice the user
 * made, so letting other species "match" them manufactures evidence: Lanmaoa
 * asiatica records no size, and species that happened to contain the default
 * 8 cm cap were scoring three extra traits of pure fiction and winning on it.
 */
export function score(params: MushroomParams, sp: Species, skip?: ReadonlySet<TraitKey>): Match {
  const traits: TraitScore[] = [];
  let sum = 0;
  let total = 0;
  const add = (key: TraitKey, label: string, w: number, sim: number, detail: string) => {
    if (skip?.has(key)) return;
    traits.push({ label, sim, detail });
    sum += w * sim;
    total += w;
  };

  if (sp.hymenium) {
    add('hymenium', 'Underside', WEIGHTS.hymenium, params.hymenium === sp.hymenium ? 1 : 0, sp.hymenium);
  }

  add('stipe', 'Stem features', WEIGHTS.stipe, stipeSim(params, sp.stipe), sp.stipe.length ? sp.stipe.join(' + ') : 'bare');

  const shp = shapeSim(params.capCurve, sp.capShape);
  if (shp !== null) add('capShape', 'Cap shape', WEIGHTS.capShape, shp, sp.capShape.join(' / '));

  if (sp.capColor) {
    const weight = WEIGHTS.capColor * (sp.colorMethod === 'auto' ? AUTO_COLOR_WEIGHT : 1);
    add(
      'capColor', 'Cap colour',
      weight,
      colorSim(params.capColor, sp.capColor),
      sp.capColorName ?? sp.capColor,
    );
  }

  // only meaningful when both sides actually have gills
  if (params.hymenium === 'gills' && sp.hymenium === 'gills' && sp.gillAttachment) {
    const a = ATTACH_AXIS[params.gillAttachment];
    const b = ATTACH_AXIS[sp.gillAttachment];
    if (a !== undefined && b !== undefined) {
      add('gillAttachment', 'Gill attachment', WEIGHTS.gillAttachment, 1 - Math.abs(a - b), sp.gillAttachment);
    }
  }

  if (sp.capCm) {
    add('capDiameter', 'Cap width', WEIGHTS.capDiameter, rangeSim(params.capDiameter, sp.capCm), `${sp.capCm[0]}–${sp.capCm[1]} cm`);
  }
  if (sp.stemCm) {
    add('stemHeight', 'Stem length', WEIGHTS.stemHeight, rangeSim(params.stemHeight, sp.stemCm), `${sp.stemCm[0]}–${sp.stemCm[1]} cm`);
  }
  if (sp.stemWidthCm) {
    add('stemWidth', 'Stem width', WEIGHTS.stemWidth, rangeSim(params.stemWidth, sp.stemWidthCm), `${sp.stemWidthCm[0]}–${sp.stemWidthCm[1]} cm`);
  }

  // hasWarts comes from keyword presence in the description, so a false is weak
  // evidence of absence -- a mismatch is softened rather than scored zero.
  const wantWarts = params.warts > 0.15;
  add('warts', 'Cap warts', WEIGHTS.warts, wantWarts === sp.hasWarts ? 1 : 0.35, sp.hasWarts ? 'warty' : 'not noted');
  const wantScales = params.scales > 0.15;
  add('scales', 'Cap scales', WEIGHTS.scales, wantScales === sp.hasScales ? 1 : 0.35, sp.hasScales ? 'scaly' : 'not noted');

  // only scored when the user actually states them; null means "I don't know"
  if (params.sporePrint && sp.sporePrint.length) {
    add('sporePrint', 'Spore print', WEIGHTS.sporePrint,
      sporeSim(params.sporePrint, sp.sporePrint), sp.sporePrint.join(' / '));
  }
  if (params.ecology && sp.ecology) {
    add('ecology', 'Ecology', WEIGHTS.ecology, params.ecology === sp.ecology ? 1 : 0, sp.ecology);
  }

  const applicable = applicableWeight(params, skip);
  // mean over what is actually recorded -- unknowns neither help nor hurt
  const score = total > 0 ? (sum / total) * 100 : 0;
  return { species: sp, score, traits, known: total, applicable };
}

/**
 * Scores within this many percentage points are treated as indistinguishable.
 * Across 1000 species a dozen can tie on identical recorded traits, and showing
 * an obscure one ahead of a famous one with the same score helps nobody.
 */
const TIE_EPSILON = 0.75;

/**
 * Top `n` matches, best first. Genuine score differences always win. Near-ties
 * prefer the better-documented species -- with unknowns no longer penalised,
 * several sparse records can legitimately tie at 100%, and the one we know most
 * about is the more useful answer -- then the better known, then name, so the
 * order is stable and never flickers mid-drag.
 */
export type RankOptions = {
  /** Traits to exclude for every species -- see score(). */
  skip?: ReadonlySet<TraitKey>;
  /** A species the user explicitly asked for; wins ties against equals. */
  prefer?: string;
};

export function rank(
  params: MushroomParams, all: Species[], n = 3, opts: RankOptions = {},
): Match[] {
  const floor = opts.skip?.size
    ? MIN_EVIDENCE * (applicableWeight(params, opts.skip) / applicableWeight(params))
    : MIN_EVIDENCE;
  return all
    .map((sp) => score(params, sp, opts.skip))
    .filter((m) => m.known >= floor)
    .sort((a, b) => {
      if (Math.abs(a.score - b.score) > TIE_EPSILON) return b.score - a.score;
      // the species the user asked to build is information too: among equals,
      // it is the answer they meant
      const pa = a.species.name === opts.prefer ? 1 : 0;
      const pb = b.species.name === opts.prefer ? 1 : 0;
      return pb - pa
        || b.known - a.known
        || (b.species.views ?? 0) - (a.species.views ?? 0)
        || a.species.name.localeCompare(b.species.name);
    })
    .slice(0, n);
}

/**
 * Traits a species' article never records. Feed to rank() as `skip` when
 * building that species, so no competitor is credited for matching a value that
 * was filled in from the defaults rather than from the data.
 */
export function unknownTraits(sp: Species): Set<TraitKey> {
  const out = new Set<TraitKey>();
  if (!sp.hymenium) out.add('hymenium');
  if (!sp.capCm) out.add('capDiameter');
  if (!sp.stemCm) out.add('stemHeight');
  if (!sp.stemWidthCm) out.add('stemWidth');
  if (!sp.capColor) out.add('capColor');
  if (!sp.capShape.some((c) => SHAPE_AXIS[c] !== undefined)) out.add('capShape');
  if (!sp.gillAttachment) out.add('gillAttachment');
  if (!sp.sporePrint.length) out.add('sporePrint');
  if (!sp.ecology) out.add('ecology');
  return out;
}


// ---------------------------------------------------------------- species -> shape

/** Vocabulary terms outside the five the model draws, folded onto the nearest. */
const ATTACH_ALIAS: Record<string, GillAttachment> = {
  subdecurrent: 'decurrent', emarginate: 'sinuate', adnexed: 'adnexed',
  free: 'free', adnate: 'adnate', sinuate: 'sinuate', decurrent: 'decurrent',
};

/**
 * Recorded sizes are ranges ("cap 8-30 cm"), so a built model has to choose a
 * point in that range. Which end it picks is the difference between a small and
 * a large specimen of the same species, so it is a visible, labelled choice
 * rather than a silent midpoint.
 */
export type SizeVariant = 'small' | 'medium' | 'large';

const pick = (r: [number, number] | null, v: SizeVariant) =>
  r ? (v === 'small' ? r[0] : v === 'large' ? r[1] : (r[0] + r[1]) / 2) : null;

/**
 * Build the 3D shape from a species' recorded traits -- the inverse of score().
 *
 * Only cap width, stem length and stem width are actually recorded as numbers.
 * Cap height is not stated anywhere in the data, so it is derived from the cap's
 * width and shape: a conical cap is proportionally much taller than a flat one.
 * Anything the article does not record falls back to the default mushroom rather
 * than being invented.
 */
export function speciesToParams(sp: Species, size: SizeVariant = 'medium'): MushroomParams {
  // The FIRST listed shape, not the average of them. Mycomorphbox lists the
  // primary shape first, and averaging "convex" with "flat" produced a curve the
  // species does not actually have -- so 231 species could not match their own
  // recorded shape.
  const shape = sp.capShape.map((c) => SHAPE_AXIS[c]).find((v): v is number => v !== undefined);
  const capCurve = shape ?? DEFAULTS.capCurve;

  const capDiameter = clamp('capDiameter', pick(sp.capCm, size) ?? DEFAULTS.capDiameter);
  // not recorded anywhere; a conical cap is far taller for its width than a flat one
  const capHeight = clamp('capHeight', capDiameter * (0.16 + 0.26 * Math.max(0, capCurve)) + 0.2);

  const hymenium: Hymenium = HYMENIA.some((h) => h.value === sp.hymenium)
    ? (sp.hymenium as Hymenium)
    : 'smooth';
  // puffballs and truffles have no stalk to speak of
  const stemless = hymenium === 'gleba' || sp.capShape.includes('offset');
  const stemHeight = clamp('stemHeight', pick(sp.stemCm, size) ?? (stemless ? 0.8 : DEFAULTS.stemHeight));

  const attach = sp.gillAttachment ? ATTACH_ALIAS[sp.gillAttachment] : undefined;

  return {
    capDiameter,
    capHeight,
    capCurve,
    stemHeight,
    stemWidth: clamp('stemWidth', pick(sp.stemWidthCm, size) ?? Math.max(0.2, capDiameter * 0.13)),
    capColor: sp.capColor ?? DEFAULTS.capColor,
    stemColor: sp.stemColor ?? '#e8dcc4',
    hymenium,
    gillAttachment: attach && ATTACHMENTS.includes(attach) ? attach : DEFAULTS.gillAttachment,
    warts: sp.hasWarts ? 0.65 : 0,
    scales: sp.hasScales ? 0.5 : 0,
    ring: sp.stipe.includes('ring'),
    volva: sp.stipe.includes('volva'),
    sporePrint: sp.sporePrint[0] ?? null,
    ecology: (sp.ecology as Ecology | null) ?? null,
  };
}

/** Apostrophes vary ("lawyer's" / "lawyers"), so compare without them. */
const norm = (t: string) => t.toLowerCase().replace(/[\u2019']/g, '').replace(/\s+/g, ' ').trim();

/**
 * Rank species against a typed query, matching the scientific name, the page
 * title and the English common names ("penny bun" finds Boletus edulis).
 * Exact beats prefix beats substring; ties go to the better-known species.
 */
export function search(query: string, all: Species[], n = 8): Species[] {
  const q = norm(query);
  if (!q) return [];
  const words = q.split(' ');
  const scored: { sp: Species; rank: number }[] = [];

  for (const sp of all) {
    const latin = [norm(sp.name), norm(sp.page)];
    const english = (sp.common ?? []).map(norm);
    let rank = -1;
    if (latin.some((t) => t === q)) rank = 0;
    else if (english.some((t) => t === q)) rank = 1;
    else if (latin.some((t) => t.startsWith(q))) rank = 2;
    else if (english.some((t) => t.startsWith(q))) rank = 3;
    else if (latin.some((t) => t.includes(q))) rank = 4;
    else if (english.some((t) => t.includes(q))) rank = 5;
    // "edulis bol" / "bun penny": every word appears somewhere
    else if (words.every((w) => [...latin, ...english].some((t) => t.includes(w)))) rank = 6;
    if (rank >= 0) scored.push({ sp, rank });
  }
  return scored
    .sort((a, b) => a.rank - b.rank || b.sp.views - a.sp.views)
    .slice(0, n)
    .map((x) => x.sp);
}

/** The English name that best explains why a query matched, for display. */
export function matchedCommonName(query: string, sp: Species): string | null {
  const q = norm(query);
  if (!q) return sp.common?.[0] ?? null;
  return (sp.common ?? []).find((c) => norm(c).includes(q)) ?? sp.common?.[0] ?? null;
}
