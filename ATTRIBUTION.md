# Sources and licensing

## Species data

Every species, trait, dimension and English name in this project is derived from
**English Wikipedia**, primarily from the `Mycomorphbox` template and the article
prose. Wikipedia text is licensed
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

Each record in `src/data/species.json` carries a `url` to its source article and
the `revid` of the exact revision it was read from, so any value can be traced
back. `src/data/species.colors.json` additionally stores the precise sentence
each hand-derived colour came from.

Pageview rankings come from the
[Wikimedia REST API](https://wikimedia.org/api/rest_v1/).

## Photographs

All photographs are hosted by **Wikimedia Commons** and remain under their own
licences — mostly CC BY, CC BY-SA, or public domain. They are **not** relicensed
by this project.

Every photo is displayed with its author, its licence, and a link to its Commons
file page, both on the match cards and in the slideshow. `src/data/species.json`
and `public/gallery.json` store those three fields for each image.

No image files are copied into this repository; they are loaded from Wikimedia
at view time.

## This project's own code

The source code in `src/`, `scripts/` and `index.html` is released under the MIT
licence (see `LICENSE`). That covers the code only — not the Wikipedia-derived
data or the photographs, which keep the licences above.

## Not an identification tool

This is a toy for exploring mushroom morphology. A high match percentage says
nothing about what is safe to eat, and deadly species are included in the data.
Never eat a wild mushroom based on this.
