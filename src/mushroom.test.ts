/**
 * Invariants of the profile that defines the mesh. Pure maths, no WebGL needed.
 * Run: npx tsx src/mushroom.test.ts
 */
import assert from 'node:assert/strict';
import { profile } from './mushroom';
import { DEFAULTS, type MushroomParams } from './params';

const p = (over: Partial<MushroomParams> = {}): MushroomParams => ({ ...DEFAULTS, ...over });
const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ~= ${b}`);

// --- the cap rim is at half the diameter, in real centimetres ---
{
  const pr = profile(p({ capDiameter: 9 }));
  close(pr.capR, 4.5);
  close(pr.top(0).x, 4.5, 1e-6); // t=0 is the rim
  close(pr.top(1).x, 0, 1e-6); // t=1 is the centre, on the axis
}

// --- capCurve sets where the centre sits relative to the rim ---
{
  const domed = profile(p({ capCurve: 0.8, capHeight: 4, stemHeight: 6 }));
  assert.ok(domed.centreY > domed.rimY, 'convex cap must dome upward');
  close(domed.centreY - domed.rimY, 3.2);

  const flat = profile(p({ capCurve: 0, capHeight: 4 }));
  close(flat.centreY, flat.rimY);

  const funnel = profile(p({ capCurve: -0.75, capHeight: 4 }));
  assert.ok(funnel.centreY < funnel.rimY, 'infundibuliform cap must sink below the rim');
}

// --- the cap surface is monotonic in both axes, so the lathe cannot self-fold ---
for (const curve of [-1, -0.5, 0.01, 0.5, 1]) {
  const pr = profile(p({ capCurve: curve, capHeight: 3, capDiameter: 10 }));
  let prevX = Infinity;
  let prevY = pr.top(0).y;
  for (let i = 0; i <= 20; i++) {
    const v = pr.top(i / 20);
    assert.ok(v.x <= prevX + 1e-9, `radius must not increase toward the centre (curve ${curve})`);
    assert.ok(v.x >= 0, 'lathe points must have non-negative radius');
    if (curve > 0) assert.ok(v.y >= prevY - 1e-9, 'domed profile must rise toward the centre');
    if (curve < 0) assert.ok(v.y <= prevY + 1e-9, 'funnel profile must fall toward the centre');
    prevX = v.x;
    prevY = v.y;
  }
}

// --- the underside is exactly the top dropped by the cap thickness ---
{
  const pr = profile(p({ capCurve: 0.5, capHeight: 3 }));
  for (const t of [0, 0.3, 0.7, 1]) {
    close(pr.top(t).x, pr.under(t).x, 1e-12);
    close(pr.top(t).y - pr.under(t).y, pr.thickness, 1e-12);
  }
}

// --- the stem must land on the cap underside, not float or pierce it ---
for (const o of [{}, { capCurve: -0.9 }, { capCurve: 1 }, { stemWidth: 6, capDiameter: 7 }]) {
  const pr = profile(p(o));
  close(pr.stemTopY, pr.under(pr.tAt(pr.stemR)).y, 1e-9);
}

// --- a stem wider than the cap is clamped, so tAt stays in range ---
{
  const pr = profile(p({ stemWidth: 50, capDiameter: 4 }));
  assert.ok(pr.stemR <= pr.capR, 'stem radius must not exceed the cap radius');
  assert.ok(pr.tAt(pr.stemR) >= 0 && pr.tAt(pr.stemR) <= 1, 'tAt must stay within [0,1]');
}

// --- degenerate inputs must stay finite (the sliders can reach these) ---
for (const o of [
  { capDiameter: 0.5, capHeight: 0.2, stemHeight: 0, stemWidth: 0.1 },
  { capDiameter: 50, capHeight: 20, stemHeight: 45, stemWidth: 8 },
  { stemHeight: 0 },
]) {
  const pr = profile(p(o));
  for (const v of [pr.capR, pr.stemR, pr.rimY, pr.centreY, pr.thickness, pr.stemTopY, pr.totalHeight]) {
    assert.ok(Number.isFinite(v), `non-finite profile value for ${JSON.stringify(o)}`);
  }
  assert.ok(pr.thickness > 0, 'cap must always have thickness');
  assert.ok(pr.totalHeight > 0, 'mushroom must have height');
}

console.log('mushroom.test.ts: all assertions passed');
