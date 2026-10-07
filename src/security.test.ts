/**
 * The shipped data is derived from Wikipedia, which anyone can edit, so it is
 * untrusted input. These assertions fail the build if a hostile or malformed
 * value could reach a URL sink, or if personal contact details leak into the
 * credit strings. Run: npx tsx src/security.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Species } from './match';

const species: Species[] = JSON.parse(readFileSync('src/data/species.json', 'utf8'));
const gallery: Record<string, { url: string; artist: string; license: string; page: string }[]> =
  JSON.parse(readFileSync('public/gallery.json', 'utf8'));

const ALLOWED_HOSTS = new Set([
  'upload.wikimedia.org', 'thumb.wikimedia.org',
  'commons.wikimedia.org', 'en.wikipedia.org',
]);

function checkUrl(url: string, where: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    assert.fail(`unparseable URL at ${where}: ${url.slice(0, 80)}`);
  }
  assert.equal(parsed.protocol, 'https:', `non-https URL at ${where}: ${url.slice(0, 80)}`);
  assert.ok(ALLOWED_HOSTS.has(parsed.host), `unexpected host at ${where}: ${parsed.host}`);
}

// --- every URL in the shipped data is https and points at Wikimedia ---
{
  let count = 0;
  for (const s of species) {
    checkUrl(s.url, `${s.name}.url`);
    count++;
    if (s.image) {
      checkUrl(s.image.url, `${s.name}.image.url`);
      checkUrl(s.image.page, `${s.name}.image.page`);
      count += 2;
    }
  }
  for (const [name, shots] of Object.entries(gallery)) {
    for (const shot of shots) {
      checkUrl(shot.url, `${name} photo`);
      checkUrl(shot.page, `${name} photo page`);
      count += 2;
    }
  }
  console.log(`  ${count} URLs: all https, all Wikimedia hosts`);
}

// --- no script-bearing schemes anywhere in the data ---
{
  for (const file of ['src/data/species.json', 'public/gallery.json']) {
    const text = readFileSync(file, 'utf8');
    for (const scheme of ['javascript:', 'vbscript:', 'data:text/html', '<script']) {
      assert.ok(!text.toLowerCase().includes(scheme), `${scheme} found in ${file}`);
    }
  }
}

// --- no email addresses in credit strings ---
// Commons' Artist field is free text and one uploader put an email in it.
// Only emails are checked: digit sequences in credits are dates and lifespans,
// not phone numbers.
{
  const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]{2,}/;
  const offenders: string[] = [];
  const check = (artist: string, where: string) => {
    if (EMAIL.test(artist)) offenders.push(`email in ${where}`);
  };
  for (const s of species) if (s.image) check(s.image.artist, s.name);
  for (const [name, shots] of Object.entries(gallery)) {
    for (const shot of shots) check(shot.artist, name);
  }
  assert.equal(offenders.length, 0, `contact details in credits: ${offenders.slice(0, 5)}`);
}

// --- every photo still carries attribution, which its licence requires ---
{
  for (const [name, shots] of Object.entries(gallery)) {
    for (const shot of shots) {
      assert.ok(shot.artist && shot.artist.length > 0, `photo without an author for ${name}`);
      assert.ok(shot.license && shot.license.length > 0, `photo without a licence for ${name}`);
    }
  }
}

console.log('security.test.ts: all assertions passed');
