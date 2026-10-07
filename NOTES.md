# Mushroom Morpher — state of the work

Handoff notes, 2026-10-05. The app is complete and working; this records what
exists, the decisions that are load-bearing, and what is still open.

Run it: `npm run dev` → http://localhost:5173 · `npm test` · `npm run typecheck`

---

## What it does

Shape a mushroom in 3D and the closest real species update live as you drag.
Or search a species by name — scientific or English — and its 3D model is built
from its recorded traits.

- **1,000 species**, all real, built from Wikipedia at build time
- **Drag** the yellow handles *or* the cap/stem themselves (sideways = width,
  up/down = height). Background drag orbits.
- **Palette** of real mushroom colours, no free colour wheel
- **Workbench** bar: which species is built, at Small/Medium/Large, with the
  exact dimensions it chose from the recorded range
- **Comparison tray**: park several species, click a chip to switch the model
- **Top 5 matches**, each with trait breakdown, edibility badges, and a photo
  slideshow (click any photo)
- **Surprise me** builds a random species; **Build me** on any match card builds
  that species without typing its name
- **Where & when**: optional season / region / habitat chips, matched at half
  weight (see "How the data was built")
- Control-panel sections collapse (native `<details>`); on phones the whole
  panel starts collapsed and the handles on the model still work
- Everything (shape, built species, size, comparison set) lives in the URL

---

## Layout

```
index.html                all markup + CSS (single file, no framework)
src/main.ts               scene, handles, panel, search, comparison, lightbox
src/mushroom.ts           profile() + 3D mesh building
src/match.ts              scoring, search, speciesToParams
src/params.ts             MushroomParams, palette, vocabularies, limits
src/drag.ts               pure screen-space drag maths (unit tested)
src/photo.ts              original Wikimedia URL -> thumbnail URL
src/data/species.json     1,000 species, its own chunk, preloaded (~940 KB, 128 KB gzip)
public/gallery.json       1,944 photos, fetched on first slideshow (~570 KB)
public/favicon.svg        the icon
src/data/species.colors.json   hand-derived colours, 207 species (authoritative)
src/data/species.raw.json      full provenance / audit trail, not shipped
scripts/build-species.ts  the whole data pipeline
scripts/colors.ts         deterministic colour extraction from prose
scripts/habitat.ts        season / region / habitat extraction from prose
scripts/.cache-*.json     pageviews, extracts, gallery — makes reruns cheap
```

---

## Decisions that are load-bearing

**Don't undo these without reading why.**

1. **Unknown traits are not scored, and not credited either.** An earlier version
   credited them at a neutral prior; that meant a species could never match its
   own model (*Podaxis pistillaris* records 4 traits, matched all 4, scored
   74.6% and lost). Sparse records are handled by an evidence floor plus a
   visible trait count instead.

2. **Building a species passes `skip` and `prefer` to `rank()`.** `skip` removes
   traits that species never records, so competitors aren't credited for matching
   a *default* value. `prefer` breaks ties toward what the user asked for. With
   both, all 1,000 species rebuild into themselves at #1. Without them it's 69%.

3. **Confidence belongs in the weight, never in the similarity.** Auto-extracted
   colours carry 55% weight. An earlier version shrank the similarity toward
   neutral, which capped a *correct* colour at 0.775.

4. **`speciesToParams` uses the FIRST listed cap shape, not the average.**
   Averaging "convex" and "flat" produced a shape the species doesn't have.

5. **Curated colours win over auto-extraction, including deliberate `null`s.**
   A `null` in `species.colors.json` means "the article states no colour" and
   must not be auto-filled.

6. **Gallery photos must name the species.** Wikipedia articles embed related
   species and cultural images. Three layers of filtering: the file list, the
   lead image, and the *resolved* URL (Commons redirects renamed files — a photo
   filed as *Trametes ochracea* resolved to *Trametes versicolor*).

7. **`renderer.setSize(w, h)` — never pass `updateStyle: false`.** Without a CSS
   size the canvas uses its attribute size, which `setPixelRatio` already scaled.
   On a Retina display that renders the canvas at double width, spilling it under
   the side panels. **Invisible at dpr 1**, which is why headless testing missed
   it — always verify with `--force-device-scale-factor=2`.

8. **Photos are always requested as thumbnails (`src/photo.ts`).** Wikimedia
   answers hotlinked originals with HTTP 429 once a page asks for a few, and an
   original can be 12 MB. Only the standard widths exist (250, 330, 500, 960,
   1280, 1920); any other width is a 400.

9. **`species.json` is a dynamic import, preloaded by `vite.config.ts`.** The
   main bundle went from 1,448 KB to 539 KB (261 -> 139 KB gzip) and the scene
   paints before the data arrives. `species` is `[]` until then, so search and
   Surprise me start disabled and the match cards start hidden.

---

## How the data was built

`npm run build:data` (set `SPECIES_COUNT` to change the 1,000).

1. Every page transcluding `Template:Mycomorphbox` (~1,800), binomials only
2. Ranked by 12-month Wikimedia pageviews, top 1,000
3. Mycomorphbox parsed for curated morphology with fixed vocabularies
4. Dimensions from article prose by attributing each measurement to its nearest
   subject word (handles cm/mm, ranges, "up to X", `25–70 × 2–3.5(-5) mm`)
5. English names from the opening sentence (707 species)
6. Up to 5 photos per species with author, licence and Commons file page

**Colours** come from two sources. Top 100 are **hand-read** into
`species.colors.json`, each beside its source sentence. The rest are
**auto-extracted** by `scripts/colors.ts`, which trusts only two phrasings
(`"the bright red cap"`, `"the cap is bright red"`) because looser matching gave
the fly agaric `"white eggs"` and *Hydnellum* `"red fluid"`. Measured against
the first 100 hand-derived species it is **74% accurate** and silent half the time.
Split: 191 hand-derived, 278 auto, 531 none.

The hand-read set was extended on 2026-10-07 by reading species 101-250: 107 got
a cap colour, chosen as a palette swatch beside its source sentence. The other 43
had no clear cap-colour sentence and were left out of the file, so they keep
auto-extraction (a recorded `null` would have blanked it). The 74% figure was not
re-measured against the larger set.

**Season, region and habitat** come from `scripts/habitat.ts`: keyword matching
over the lead paragraph and the habitat / distribution / ecology sections only,
skipping sentences that negate or compare ("absent from", "related species
occur in"). Coverage: region 881 species, habitat 825, season 353. A 30-species
spot check across the popularity range found one wrong value after tuning
(*Phellinus ellipsoideus* gets Europe from a sentence about another fungus), so
treat it as roughly as reliable as the auto colours, which is why each weighs 0.5.
Months are deliberately not mapped to seasons: March is autumn in Australia.

---

## Verification

`npm test` is three assert-based files, no framework:

- `match.test.ts` — scoring, search (incl. English names), palette coverage,
  round trip (all 1,000 at #1, at every size), vocabulary normalisation,
  slider ranges, gallery integrity
- `mushroom.test.ts` — profile geometry invariants
- `drag.test.ts` — drag projection maths and sign conventions

Browser behaviour was verified by driving the live app from a same-origin probe
page that POSTs results to a tiny collector (headless Chrome exits on
`--screenshot`, and a cross-origin iframe has no `contentDocument` — both cost
me time). **Use `--force-device-scale-factor=2`**; dpr-1 testing hides real bugs.

---

## Known limits

- 240 species have no recorded cap width, 382 no stem length (mostly genuine —
  puffballs, truffles and brackets have neither)
- 575 have no cap colour; 293 have no English name
- Cap height is the one dimension no article records; it is derived from width
  and shape, not sourced
- `hasWarts`/`hasScales` come from keyword presence, so `false` is weak evidence
- Many species legitimately tie at 100%; the trait count on each card shows why
- 22 species have no verified photo and render a placeholder
- `pores` vs `smooth` look alike until you orbit under the cap
- 6 species fall below the evidence floor and never rank (e.g. *Claviceps purpurea*)
- Picking a region, season or habitat that few well-matching species record can
  put a species with *no* recorded value at #1: unknown traits are not scored
  (decision 1), so it loses nothing while the others lose half a point
- Two "species" are common-name pages that pass the binomial filter (*Shaggy
  parasol*, *Candy cap*); the former's infobox name changed upstream on
  2026-10-07, so it now displays under its page title
- `npm run build:data` needs the network for wikitext and image metadata even
  with warm caches, so a rerun picks up live article edits

---

## Open ideas, not started

- Spore print and ecology are matched but have no 3D representation (they are
  dropdown/chips only) — fine, they're invisible on a real mushroom too
- `species.json` could shrink further: `url` and `image.page` are derivable
  (~125 KB raw, but only ~10 KB gzip, so it was not worth the type changes)
- No persistence beyond the URL; no server

## Not an identification tool

A high percentage says nothing about what is safe to eat, and deadly species are
in the dataset. The banner must stay.
