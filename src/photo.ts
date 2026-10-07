/**
 * Wikimedia throttles hotlinked originals (HTTP 429), and an original can be
 * 12 MB for a card 118 px tall. Its thumbnailer is not throttled the same way,
 * so every photo is requested as a thumbnail instead.
 *
 * Only these widths are served; anything else is a 400.
 */
export type ThumbWidth = 250 | 330 | 500 | 960 | 1280 | 1920;

const ORIGINAL = /^(https:\/\/upload\.wikimedia\.org\/wikipedia\/[a-z-]+)\/([0-9a-f]\/[0-9a-f]{2})\/([^/?#]+)/;

/** An original upload URL -> its thumbnail. Anything else is returned unchanged. */
export function wikiThumb(url: string, width: ThumbWidth): string {
  const m = ORIGINAL.exec(url);
  if (!m) return url; // already a thumbnail, or not a shape we recognise
  const [, base, hash, file] = m;
  // SVGs are only ever thumbnailed as PNG
  return `${base}/thumb/${hash}/${file}/${width}px-${file}${/\.svg$/i.test(file) ? '.png' : ''}`;
}
