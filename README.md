# Mushroom Morpher

Shape a mushroom in 3D and watch the closest real species update as you drag.
Or search for a species by name and have its 3D model built from its recorded traits.

## Where the species come from

The 1,000 species are **real and sourced**, not invented. `scripts/build-species.ts`
builds them from Wikipedia:

1. Lists every page transcluding [`Template:Mycomorphbox`](https://en.wikipedia.org/wiki/Template:Mycomorphbox)
   (~1,800 pages) and keeps the binomials.
2. Ranks them by 12-month pageviews via the Wikimedia REST API and takes the top 1,000
   (`SPECIES_COUNT=250 npm run build:data` for a smaller set).
3. Parses the Mycomorphbox for curated morphology with fixed value vocabularies:
   `capShape`, `hymeniumType`, `whichGills`, `stipeCharacter`, `sporePrintColor`,
   `ecologicalType`, `howEdible`.
4. Extracts cap and stem dimensions from the article's plaintext description by
   attributing each measurement to its nearest subject word, handling cm/mm, ranges,
   `"up to X"`, and the `"25–70 × 2–3.5 mm"` notation.
5. Fetches the lead photo plus its Commons artist and licence for attribution.

Run it with `npm run build:data`. Pageviews and extracts are cached under
`scripts/.cache-*.json`, so reruns are cheap.

**Cap and stem colours** are not in any structured field — they only exist as prose
("the bright red cap", "a carrot-orange cap"), and they come from two sources:

- **Hand-derived** for the top 100 species, in `src/data/species.colors.json`, each
  value sitting next to the exact sentence it came from. A species listed there is
  final, *including* a deliberate `null` meaning "the article states no colour".
- **Auto-extracted** for the rest, by `scripts/colors.ts`. It trusts only two
  phrasings — `"the bright red cap"` and `"the cap is bright red"` — because looser
  matching picked up `"white eggs"` for the fly agaric and `"red fluid"` for
  *Hydnellum peckii*. Measured against the 100 hand-derived colours it is right
  about **74%** of the time and stays silent for half of all species.

Because auto colours are measurably less reliable, the matcher shrinks their
similarity toward the neutral prior, so a wrong one costs roughly half what a wrong
curated colour would. Current split: 191 hand-derived, 278 auto, 531 with no colour.

**The colour picker** offers a fixed palette built from the colours real species
actually have, rather than a free colour wheel — no mushroom is hot pink or cyan, so
those can never match anything. The olives, violets, pinks and indigos in it are each
justified by a real species (*Amanita phalloides* is olive-green, *Russula virescens*
is green, *Entoloma hochstetteri* is indigo). A test asserts every curated colour is
reachable from the palette.

`species.raw.json` keeps the full descriptions and is the audit trail — the app only
loads the merged `species.json`.

**Season, region and habitat** are also prose-only. `scripts/habitat.ts` reads them
by keyword from the lead paragraph and the habitat / distribution sections, into fixed
vocabularies (four seasons, six continents, six habitats). They are optional in the
panel and count for half as much as a measured trait.

## Building a species from its name

The search box is the inverse of the matcher: `speciesToParams()` turns a species'
recorded traits back into a 3D shape. It accepts **scientific or English names** —
"penny bun", "death cap" and "lion's mane" all work, with or without the apostrophe.
English names are extracted at build time from the article's opening sentence
("*Coprinus comatus*, commonly known as the shaggy ink cap, lawyer's wig, or shaggy
mane"); 707 of the 1,000 species have at least one.

Only cap width, stem length and stem width are recorded as numbers — cap height is
derived from width and shape, since a conical cap is proportionally far taller than a
flat one. Anything unrecorded falls back to the default mushroom rather than being
invented.

**Size variants.** Recorded sizes are ranges, so a built model has to choose a point
in one: *Boletus edulis* is "8–30 cm" across. That choice is an explicit
Small / Medium / Large control rather than a silent midpoint, and the workbench states
exactly what it picked — `large specimen · cap 30.0 cm of 8–30 cm`.

**Comparison.** Add species from the search dropdown (`+ compare`) or from the
workbench. Only one model is ever rendered; the chips switch between them instantly,
so you can flip back and forth to see how shape, size and colour differ. Editing the
shape by hand drops the species label — it is no longer that species — but keeps the
comparison set. The built species, its size variant and the whole comparison set all
travel in the URL, so a comparison can be linked.

A round-trip test keeps the two directions honest: build a species' shape, feed it to
the matcher, and it should find that species again. 62% of well-documented species
come back at #1, and the rest lose only to genuinely near-identical relatives.

## How matching works

Each trait contributes a similarity in `[0,1]` times a weight, heaviest on the
hymenium (the strongest real identification signal). The score is the weighted mean
over **the traits a species actually records** — unknowns neither help nor hurt.

Two safeguards stop that from being exploited:

- A species must reach a minimum weight of scorable traits to be ranked at all.
  *Claviceps purpurea* records nothing but a stem character, and without this floor
  it scored ~100% off a single lucky trait. 6 of 1,000 species are excluded.
- Each match reports **how many traits it was scored on**, so a 100% from three
  traits is never mistaken for a 100% from nine.

An earlier version instead credited unknown traits at a neutral prior. That had a
fatal flaw: a species could not match its own model. *Podaxis pistillaris* records
only four traits, matched all four perfectly, and still scored 74.6% — losing to
well-documented species that merely resembled the fallback shape. Being poorly
documented was itself a penalty, which is wrong: the score answers *"how well does
this fit what we know"*, not *"how much do we know"*.

Colour distance is computed in CIE L\*a\*b\*, because raw RGB distance ranks dark red
as nearly black. Auto-extracted colours carry reduced **weight** rather than a
reduced similarity — low confidence must mean "counts for less", never "cannot be
right".

Scores within 0.75 points are treated as ties, broken by how much is known about the
species, then by pageviews: across 1,000 species a dozen can share identical recorded
traits, and showing an obscure one ahead of a famous one with the same score helps
nobody.

### Building a species is a different question

When you build a named species, the matcher is told two extra things:

- **Which traits that species never records.** Those are excluded for *every*
  species. Otherwise a competitor gets credit for matching a dimension that came
  from the defaults rather than from the data — *Lanmaoa asiatica* records no size,
  and rivals were scoring three traits of pure fiction against its fallback 8 cm cap.
- **Which species you asked for**, which breaks ties among equally-good matches.
  Your choice is information too.

With both, **all 1,000 species rebuild into themselves at #1**, at every size
variant — asserted in the tests. Editing the shape by hand clears this: the values
become real choices again.

## Known limits

- 240 of 1,000 species have no recorded cap width and 382 no stem length — mostly
  genuine (puffballs, truffles and brackets have neither). Missing traits are scored
  at a neutral prior, never dropped: dropping them let a species with almost nothing
  recorded score ~100% off two lucky traits.
- 20 species have no photo on their Wikipedia article and render a placeholder.
- `hasWarts` comes from keyword presence in the description, so a `false` is weak
  evidence of absence; mismatches are softened rather than scored zero.
- Many species legitimately tie at 100%: with only a handful of traits recorded,
  the data genuinely cannot separate them. The trait count on each card shows this.
- `pores` and `smooth` look nearly identical until you orbit below the cap.
- 293 species have no English name in their article's opening sentence, so they are
  findable only by their scientific name.
- Cap height is the one dimension no article records; it is derived, not sourced.

## Not an identification tool

This is a toy for exploring morphology. A high match percentage says nothing about
what is safe to eat, and several deadly species are in the dataset. Never eat a wild
mushroom based on this.
