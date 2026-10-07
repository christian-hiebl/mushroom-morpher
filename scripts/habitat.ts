/**
 * Deterministic season / region / habitat extraction from Wikipedia prose.
 *
 * None of these are in the Mycomorphbox; they only exist as sentences ("fruits
 * from late summer to autumn under beech in Europe"). Like colours.ts this is
 * keyword matching, so it is deliberately narrow about WHERE it looks: only the
 * lead paragraph and the habitat/distribution/ecology sections. The description,
 * taxonomy and similar-species sections talk about other mushrooms and other
 * places ("resembles the North American X"), and reading them would attribute a
 * lookalike's range to this species.
 */

import { HABITATS, REGIONS, SEASONS } from '../src/params';

/**
 * "fall" is also a verb, so it only counts next to a word that makes it a
 * season. Months are NOT mapped to seasons: March is spring in Europe and
 * autumn in Australia, and plenty of these species are southern.
 */
const SEASON_WORDS: Record<(typeof SEASONS)[number], RegExp> = {
  spring: /\b(?:spring|springtime|vernal)\b(?! (?:water|fed|up|from|forth))/i,
  summer: /\bsummers?\b/i,
  autumn: /\bautumn(?:al)?\b|\b(?:in|during|through|throughout|until|into|to|and|or|late|early|mid|summer,?) (?:the )?fall\b(?! (?:from|off|out|into|apart))/i,
  winter: /\bwinters?\b/i,
};

const REGION_WORDS: Record<(typeof REGIONS)[number], RegExp> = {
  Europe: /\b(?:Europe(?:an)?|Britain|British Isles|United Kingdom|(?<!New )England|Scotland|(?<!New South )Wales|Ireland|France|Germany|Italy|Spain|Portugal|Netherlands|Belgium|Switzerland|Austria|Poland|Czech Republic|Scandinavia|Sweden|Norway|Finland|Denmark|Iceland|Greece|Balkans|Mediterranean)\b/,
  'North America': /\b(?:North America(?:n)?|United States|Canada|Mexico|Central America|Caribbean|Costa Rica|California|Oregon|Washington state|Pacific Northwest|Rocky Mountains|Appalachian\w*|Alaska|Florida|Texas|New England|Great Lakes|Quebec|British Columbia|Hawaii)\b/,
  'South America': /\b(?:South America(?:n)?|Brazil|Argentina|Chile|Colombia|Ecuador|Peru|Venezuela|Bolivia|Uruguay|Patagonia|Amazon(?:ia)?)\b/,
  Asia: /\b(?:Asia(?:n)?|China|Japan|Korea|India|Nepal|Pakistan|Siberia|Thailand|Vietnam|Malaysia|Indonesia|Philippines|Taiwan|Sri Lanka|Iran|Turkey|Himalayas?)\b/,
  Africa: /\b(?:Africa(?:n)?|Morocco|Algeria|Kenya|Tanzania|Uganda|Ethiopia|Nigeria|Ghana|Cameroon|Congo|Zambia|Zimbabwe|Madagascar)\b/,
  Australasia: /\b(?:Australasia|Australia(?:n)?|New Zealand|Tasmania|New South Wales|Victoria, Australia|Queensland|New Guinea)\b/,
};
// a bare "worldwide" is not enough: "recorded on ten host genera worldwide"
const EVERYWHERE = /\b(?:cosmopolitan|(?:distribut\w+|found|occurs?|widespread|grows?|common) (?:\w+ )?world-?wide|world-?wide (?:distribution|range)|every continent|all continents)\b/i;

const HABITAT_WORDS: Record<(typeof HABITATS)[number], RegExp> = {
  conifers: /\b(?:conifer(?:s|ous)?|pines?|spruces?|firs?|larch(?:es)?|hemlocks?|cedars?|Pinus|Picea|Abies|Larix|Tsuga)\b/i,
  'broadleaf trees': /\b(?:hardwoods?|deciduous|broad-?lea(?:f|ved)|oaks?|beech(?:es)?|birch(?:es)?|chestnuts|chestnut trees?|poplars?|aspens?|willows?|alders?|hornbeams?|eucalypt\w*|limes?trees?|Quercus|Fagus|Betula|Populus|Salix|Castanea|Eucalyptus|Nothofagus)\b/i,
  grassland: /\b(?:grass(?:land|lands|y|es)?|lawns?|meadows?|pastures?|fields)\b/i,
  'dead wood': /\b(?:(?:dead|rotting|rotten|decaying|decayed|fallen) (?:\w+ )?(?:wood|logs?|trunks?|branches|timber)|logs|stumps?|woody debris|wood ?chips|sawdust|on wood)\b/i,
  dung: /\b(?:dung|manure|droppings)\b/i,
  'burnt ground': /\b(?:burn(?:t|ed)|fire ?sites?|fireplaces?|bonfires?|charcoal|charred|after (?:forest )?fires?)\b/i,
};

/**
 * A sentence saying where the species is NOT must not count as where it is, and
 * neither must one comparing it to something else ("related species occur in
 * South America", "whereas F. fomentarius is found worldwide").
 */
const NEGATED = /\b(?:related species|closely related|similar (?:species|to)|resembl\w+|look-?alikes?|whereas|unlike|in contrast|compared (?:to|with)|previously thought|formerly|once thought|absent|not (?:been |yet )?(?:found|recorded|reported|known|occur)|unknown (?:from|in)|never|does not (?:occur|grow|fruit)|unconfirmed|doubtful|erroneous|misidentif\w+)\b/i;

const RELEVANT_HEADING = /habitat|distribution|ecology|range/i;

/** The lead paragraph plus every habitat/distribution/ecology section. */
export function relevantText(text: string): string {
  // Wikipedia plaintext extracts put a heading on its own line after two blank ones
  const parts = text.split(/\n\n\n([^\n]{2,60})\n/);
  const out = [parts[0]];
  for (let i = 1; i < parts.length; i += 2) {
    if (RELEVANT_HEADING.test(parts[i])) out.push(parts[i + 1] ?? '');
  }
  return out.join('\n');
}

export type Habitat = { season: string[]; regions: string[]; habitat: string[] };

export function extractHabitat(text: string): Habitat {
  const season = new Set<string>();
  const regions = new Set<string>();
  const habitat = new Set<string>();
  for (const sentence of relevantText(text).split(/(?<=[.!?])\s+|\n+/)) {
    if (NEGATED.test(sentence)) continue;
    const here: number[] = [];
    SEASONS.forEach((s, i) => { if (SEASON_WORDS[s].test(sentence)) here.push(i); });
    // "from spring to autumn" names two seasons but means three
    if (here.length === 2 && here[1] - here[0] > 1 &&
        /\b(?:to|through|until|into|till)\b|[–—-]/.test(sentence)) {
      for (let i = here[0]; i <= here[1]; i++) season.add(SEASONS[i]);
    }
    for (const i of here) season.add(SEASONS[i]);
    if (EVERYWHERE.test(sentence)) for (const r of REGIONS) regions.add(r);
    if (/\bEurasian?\b/.test(sentence)) { regions.add('Europe'); regions.add('Asia'); }
    for (const r of REGIONS) if (REGION_WORDS[r].test(sentence)) regions.add(r);
    for (const h of HABITATS) if (HABITAT_WORDS[h].test(sentence)) habitat.add(h);
  }
  // fixed vocabulary order, so the output is stable across runs
  return {
    season: SEASONS.filter((s) => season.has(s)),
    regions: REGIONS.filter((r) => regions.has(r)),
    habitat: HABITATS.filter((h) => habitat.has(h)),
  };
}
