/**
 * Smallest thing that fails if the scoring logic breaks. Run: npx tsx src/match.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  rank, score, search, speciesToParams, unknownTraits, colorSim, rangeSim, type Species,
} from './match';
import { DEFAULTS, type MushroomParams } from './params';

const all: Species[] = JSON.parse(readFileSync('src/data/species.json', 'utf8'));
const p = (over: Partial<MushroomParams>): MushroomParams => ({ ...DEFAULTS, ...over });
const find = (n: string) => {
  const s = all.find((x) => x.name === n);
  assert.ok(s, `fixture species missing: ${n}`);
  return s;
};

// --- building a mushroom from a species' own recorded traits should find it again ---

{
  // Amanita muscaria: gills/free, convex+flat, ring and volva, bright red, warty, 5-30cm
  const top = rank(p({
    capDiameter: 14, capHeight: 5, capCurve: 0.45, stemHeight: 12, stemWidth: 1.5,
    capColor: '#d8291c', hymenium: 'gills', gillAttachment: 'free',
    warts: 0.7, ring: true, volva: true,
  }), all);
  assert.equal(top[0].species.name, 'Amanita muscaria', `got ${top[0].species.name}`);
  assert.ok(top[0].score > 90, `score too low: ${top[0].score}`);
}

{
  // Hydnum repandum: teeth/decurrent, depressed cap, bare stem, orange -- a very
  // different corner of the trait space, so this catches a matcher that always
  // returns the same popular species.
  const top = rank(p({
    capDiameter: 10, capCurve: -0.45, stemHeight: 6, stemWidth: 2,
    capColor: '#e0a040', hymenium: 'teeth', gillAttachment: 'decurrent',
    warts: 0, ring: false, volva: false,
  }), all);
  assert.equal(top[0].species.name, 'Hydnum repandum', `got ${top[0].species.name}`);
}

{
  // Lactarius indigo, built from its own recorded traits: depressed cap, adnate
  // gills, 4-15 cm, indigo blue. Colour must be decisive among its lookalikes.
  const indigoProfile = {
    capCurve: -0.45, gillAttachment: 'adnate' as const, hymenium: 'gills' as const,
    capDiameter: 9, stemHeight: 5, stemWidth: 1.5,
  };
  const withIndigo = rank(p({ ...indigoProfile, capColor: '#3a56a0' }), all);
  assert.equal(withIndigo[0].species.name, 'Lactarius indigo', `got ${withIndigo[0].species.name}`);

  // the same mushroom in brown must NOT return the blue one -- proving the
  // colour is doing real work rather than the shape carrying it alone
  const withBrown = rank(p({ ...indigoProfile, capColor: '#8a5a2b' }), all);
  assert.notEqual(withBrown[0].species.name, 'Lactarius indigo');
}

// --- the underside is the heaviest trait, so switching it must change the result ---

{
  const gilled = rank(p({ hymenium: 'gills' }), all)[0].species;
  const pored = rank(p({ hymenium: 'pores' }), all)[0].species;
  assert.equal(gilled.hymenium, 'gills');
  assert.equal(pored.hymenium, 'pores');
}

// --- missing data must not penalise a species ---

{
  const noColor = find('Trametes versicolor'); // article never states a cap colour
  assert.equal(noColor.capColor, null);
  const red = score(p({ capColor: '#ff0000' }), noColor);
  const blue = score(p({ capColor: '#0000ff' }), noColor);
  assert.equal(red.score, blue.score, 'colourless species changed score with cap colour');
  assert.ok(!red.traits.some((t) => t.label === 'Cap colour'), 'scored a colour it does not have');

  // and a species WITH colour data must respond to it
  const muscaria = find('Amanita muscaria');
  assert.ok(
    score(p({ capColor: '#d8291c' }), muscaria).score > score(p({ capColor: '#3a56a0' }), muscaria).score,
    'species with colour data ignored cap colour',
  );
}

// --- determinism: equal inputs, equal order ---

{
  const a = rank(p({}), all, 10).map((m) => m.species.name);
  const b = rank(p({}), all, 10).map((m) => m.species.name);
  assert.deepEqual(a, b);
}

// --- primitives ---

assert.equal(rangeSim(10, [5, 30]), 1, 'inside range');
assert.equal(rangeSim(5, [5, 30]), 1, 'on the boundary');
assert.ok(rangeSim(40, [5, 30]) < 1 && rangeSim(40, [5, 30]) > 0, 'just outside tapers');
assert.equal(rangeSim(500, [5, 30]), 0, 'far outside bottoms out');
assert.ok(rangeSim(3, [1, 2]) < rangeSim(3, [1, 20]), 'tight ranges are stricter');

assert.equal(colorSim('#ff0000', '#ff0000'), 1, 'identical colours');
assert.ok(colorSim('#8b0000', '#000000') < 0.9, 'dark red is not black');
assert.ok(colorSim('#d8291c', '#e03a2a') > 0.8, 'two reds are close');
assert.ok(colorSim('#ffffff', '#000000') === 0, 'opposite ends bottom out');

// --- every record is usable by the UI ---

assert.ok(all.length >= 1000, `expected at least 1000 species, got ${all.length}`);
for (const s of all) {
  assert.ok(s.name && s.url && s.revid, `incomplete record: ${s.page}`);
  // an image is optional, but one that exists must carry its licence for attribution
  if (s.image) assert.ok(s.image.url && s.image.license, `image without licence: ${s.name}`);
}
const withImage = all.filter((s) => s.image?.url).length;
assert.ok(withImage / all.length > 0.95, `only ${withImage}/${all.length} have photos`);

// curated colours must never be overwritten by auto-extraction
{
  const curated = JSON.parse(readFileSync('src/data/species.colors.json', 'utf8'));
  for (const [page, v] of Object.entries<any>(curated)) {
    if (page === '_note') continue;
    const sp = all.find((s) => s.page === page);
    if (!sp) continue;
    assert.equal(sp.capColor, v.capColor ?? null, `curated colour overwritten for ${page}`);
    assert.notEqual(sp.colorMethod, 'auto', `curated species marked auto: ${page}`);
  }
}

console.log('match.test.ts: all assertions passed');

// --- the palette must be able to express the species' real colours ---
// A fixed palette replaces the free colour wheel; a species whose recorded colour
// sits far from every swatch can never be found by colour.
{
  const { PALETTE } = await import('./params');
  const dE = (hex: string) => (1 - Math.max(...PALETTE.map((sw) => colorSim(sw.hex, hex)))) * 60;
  const coloured = all.filter((s) => s.capColor);
  assert.ok(coloured.length > 300, `too few coloured species: ${coloured.length}`);

  // hand-derived colours are authoritative and must be closely reachable
  let worstManual = { name: '', d: 0 };
  for (const s of coloured) {
    if (s.colorMethod !== 'manual') continue;
    const d = dE(s.capColor!);
    if (d > worstManual.d) worstManual = { name: s.name, d };
  }
  assert.ok(worstManual.d < 12, `palette cannot express curated ${worstManual.name} (dE ${worstManual.d.toFixed(1)})`);

  // auto-extracted colours only need broad coverage
  const ds = coloured.map((s) => dE(s.capColor!)).sort((a, b) => a - b);
  const p95 = ds[Math.floor(ds.length * 0.95)];
  assert.ok(p95 < 15, `95% of species should be within dE 15 of a swatch, got ${p95.toFixed(1)}`);
  assert.ok(ds[ds.length - 1] < 20, `worst species is dE ${ds[ds.length - 1].toFixed(1)} from any swatch`);

  console.log(`  palette: curated worst dE ${worstManual.d.toFixed(1)}, p95 ${p95.toFixed(1)}, max ${ds[ds.length - 1].toFixed(1)}`);
}


// --- round trip: build a species' shape, and the matcher should find it again ---
// This ties the two directions together: if speciesToParams drifts from what
// score() rewards, named species stop rebuilding into themselves.
{
  const named = ['Boletus edulis', 'Amanita muscaria', 'Hydnum repandum', 'Amanita phalloides',
                 'Coprinus comatus', 'Cantharellus cibarius', 'Lactarius indigo', 'Macrolepiota procera'];
  for (const n of named) {
    const sp = find(n);
    const top = rank(speciesToParams(sp), all, 5);
    const at = top.findIndex((m) => m.species.name === n);
    assert.ok(at >= 0, `${n} rebuilt into itself but ranked outside the top 5: ${top.map((m) => m.species.name)}`);
  }

  // EVERY species must rebuild into itself. This is the property that broke when
  // Podaxis pistillaris built a model whose top match was Psilocybe cubensis:
  // Podaxis records only four traits, matched all four perfectly, and was still
  // beaten because unknown traits were penalised and the fallback dimensions were
  // credited to better-documented species.
  const missed: string[] = [];
  for (const sp of all) {
    const top = rank(speciesToParams(sp), all, 1, {
      skip: unknownTraits(sp), prefer: sp.name,
    });
    if (top[0]?.species.name !== sp.name) missed.push(sp.name);
  }
  assert.equal(missed.length, 0,
    `${missed.length} species do not rebuild into themselves: ${missed.slice(0, 8)}`);
  console.log(`  round trip: all ${all.length} species rebuild to #1`);

  // ... and at every size variant, not just the default one
  const sizeMissed: string[] = [];
  for (const sp of all) {
    for (const v of ['small', 'large'] as const) {
      const top = rank(speciesToParams(sp, v), all, 1, {
        skip: unknownTraits(sp), prefer: sp.name,
      });
      if (top[0]?.species.name !== sp.name) sizeMissed.push(`${sp.name}/${v}`);
    }
  }
  assert.equal(sizeMissed.length, 0,
    `${sizeMissed.length} species fail at a size extreme: ${sizeMissed.slice(0, 6)}`);
}

// --- a species must be able to match its own recorded traits perfectly ---
// Building a species then scoring it was capped below 100% by two bugs: cap
// shape was built as the AVERAGE of its listed shapes (a shape it does not
// have), and an auto-extracted colour had its similarity shrunk toward neutral
// rather than its weight reduced, so a correct colour could never score 1.0.
{
  for (const n of ['Amanita muscaria', 'Boletus edulis', 'Podaxis pistillaris', 'Lanmaoa asiatica']) {
    const sp = find(n);
    const m = score(speciesToParams(sp), sp, unknownTraits(sp));
    const weak = m.traits.filter((t) => t.sim < 0.999);
    assert.equal(weak.length, 0,
      `${n} cannot match its own traits: ${weak.map((t) => `${t.label}=${t.sim.toFixed(2)}`)}`);
    assert.ok(m.score > 99.9, `${n} scores ${m.score.toFixed(1)}% against its own model`);
  }
}

// --- vocabularies must be normalised, not passed through raw ---
{
  const HYMENIA = new Set(['gills', 'pores', 'teeth', 'ridges', 'smooth', 'gleba']);
  const ATTACH = new Set(['free', 'adnexed', 'adnate', 'sinuate', 'decurrent']);
  for (const s of all) {
    if (s.hymenium) assert.ok(HYMENIA.has(s.hymenium), `bad hymenium ${JSON.stringify(s.hymenium)} on ${s.name}`);
    if (s.gillAttachment) {
      assert.ok(ATTACH.has(s.gillAttachment), `bad attachment ${JSON.stringify(s.gillAttachment)} on ${s.name}`);
    }
  }
}

// --- every recorded size must be representable by the sliders ---
// Clamping below a species' recorded size means it cannot match itself.
{
  const { LIMITS } = await import('./params');
  for (const s of all) {
    if (s.capCm) assert.ok(s.capCm[1] <= LIMITS.capDiameter[1], `${s.name} cap ${s.capCm[1]}cm exceeds the slider`);
    if (s.stemCm) assert.ok(s.stemCm[1] <= LIMITS.stemHeight[1], `${s.name} stem ${s.stemCm[1]}cm exceeds the slider`);
    if (s.stemWidthCm) assert.ok(s.stemWidthCm[1] <= LIMITS.stemWidth[1], `${s.name} stem width ${s.stemWidthCm[1]}cm exceeds the slider`);
  }
}

// --- search finds species by scientific AND English name ---
{
  assert.equal(search('Boletus edulis', all)[0].name, 'Boletus edulis');
  assert.equal(search('boletus edulis', all)[0].name, 'Boletus edulis');
  assert.ok(search('amanita', all).length > 1, 'genus search should return several');
  assert.equal(search('', all).length, 0, 'empty query returns nothing');
  assert.equal(search('zzzznotathing', all).length, 0, 'nonsense returns nothing');
  assert.equal(search('amanita', all)[0].name, 'Amanita muscaria', 'best known first');

  // English names must work, since most people do not know the Latin
  const english: [string, string][] = [
    ['fly agaric', 'Amanita muscaria'],
    ['death cap', 'Amanita phalloides'],
    ['penny bun', 'Boletus edulis'],
    ['porcino', 'Boletus edulis'],
    ['shaggy mane', 'Coprinus comatus'],
    ['oyster mushroom', 'Pleurotus ostreatus'],
    ["lion's mane", 'Hericium erinaceus'],
    ['lions mane', 'Hericium erinaceus'], // apostrophe optional
    ['parasol mushroom', 'Macrolepiota procera'],
  ];
  for (const [q, want] of english) {
    const got = search(q, all)[0];
    assert.ok(got, `no result for "${q}"`);
    assert.equal(got.name, want, `"${q}" gave ${got.name}`);
  }
}

// --- names must be clean enough to display ---
{
  for (const s of all) {
    assert.ok(
      !/[{}<>|\[\]]|italic|DEFAULTSORT/i.test(s.name),
      `markup leaked into species name: ${JSON.stringify(s.name)}`,
    );
    assert.ok(s.name.length < 60, `implausible species name: ${JSON.stringify(s.name)}`);
  }
  const withCommon = all.filter((s) => s.common?.length).length;
  assert.ok(withCommon > 500, `only ${withCommon} species have English names`);
}

// --- size variants span the recorded range ---
{
  const sp = find('Boletus edulis');
  assert.ok(sp.capCm, 'fixture needs a recorded cap range');
  const small = speciesToParams(sp, 'small');
  const medium = speciesToParams(sp, 'medium');
  const large = speciesToParams(sp, 'large');
  assert.ok(small.capDiameter < medium.capDiameter, 'small must be smaller than medium');
  assert.ok(medium.capDiameter < large.capDiameter, 'medium must be smaller than large');
  assert.equal(small.capDiameter, sp.capCm![0], 'small is the low end of the recorded range');
  assert.equal(large.capDiameter, sp.capCm![1], 'large is the high end');
  // shape and colour must not drift with size
  assert.equal(small.hymenium, large.hymenium);
  assert.equal(small.capColor, large.capColor);

  // every size variant should still identify as the same species
  for (const v of ['small', 'medium', 'large'] as const) {
    const top = rank(speciesToParams(sp, v), all, 5).map((m) => m.species.name);
    assert.ok(top.includes('Boletus edulis'), `${v} Boletus edulis not in top 5: ${top}`);
  }
}

// --- gallery photos must belong to the species they are filed under ---
// Wikipedia articles embed related species and cultural images; Amanita
// muscaria's page carries a 4th-century mosaic and a photo of Amanita crocea.
// Showing a different mushroom in a species gallery is worse than showing none.
{
  const gallery: Record<string, { url: string; artist: string; license: string; page: string }[]> =
    JSON.parse(readFileSync('public/gallery.json', 'utf8'));
  const names = new Set(all.map((s) => s.name));
  const epithets = new Map<string, Set<string>>();
  for (const s of all) {
    const [g, e] = s.name.toLowerCase().split(' ');
    if (!e) continue;
    if (!epithets.has(g)) epithets.set(g, new Set());
    epithets.get(g)!.add(e);
  }

  let total = 0;
  for (const [species, shots] of Object.entries(gallery)) {
    assert.ok(names.has(species), `gallery references unknown species: ${species}`);
    assert.ok(shots.length > 0 && shots.length <= 5, `${species} has ${shots.length} photos`);
    const seen = new Set<string>();
    for (const shot of shots) {
      total++;
      assert.ok(/^https:\/\//.test(shot.url), `bad photo url for ${species}`);
      assert.ok(shot.license, `photo without a licence for ${species}`);
      const file = decodeURIComponent(shot.url.split('?')[0].split('/').pop()!)
        .replace(/^\d+px-/, '').toLowerCase();
      assert.ok(!seen.has(file), `${species} lists the same photo twice: ${file}`);
      seen.add(file);

      assert.ok(shot.page?.startsWith('https://'), `photo without a source page for ${species}`);

      // the filename must not name a DIFFERENT species unless it also names
      // this one: "morchella elata spitzmorchel morchella conica.jpg" is a
      // picture of elata that happens to mention a synonym
      const [genus, epithet] = species.toLowerCase().split(' ');
      if (!epithet) continue;
      const nameish = file.replace(/[_-]+/g, ' ');
      if (nameish.includes(`${genus} ${epithet}`) || nameish.includes(epithet)) continue;
      for (const other of epithets.get(genus) ?? []) {
        if (other === epithet) continue;
        assert.ok(!nameish.includes(`${genus} ${other}`),
          `${species} gallery contains ${genus} ${other}: ${file}`);
      }
    }
  }
  console.log(`  gallery: ${Object.keys(gallery).length} species, ${total} photos, all species-matched`);
}
