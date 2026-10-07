/**
 * The drag maths must move a handle with the cursor, not against it or at the
 * wrong rate. Run: npx tsx src/drag.test.ts
 */
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { alongAxis, screenAxis, worldPerPixel } from './drag';

const W = 1200;
const H = 800;
const cam = () => {
  const c = new PerspectiveCamera(42, W / H, 0.1, 2000);
  c.position.set(0, 0, 20);
  c.lookAt(0, 0, 0);
  c.updateMatrixWorld(true);
  return c;
};

// --- axis directions land where a viewer would expect them ---
{
  const c = cam();
  const o = new Vector3(0, 0, 0);

  const right = screenAxis(c, o, new Vector3(1, 0, 0));
  assert.ok(right.x > 0.99, `+X should point right on screen, got ${right.x}`);

  // +Y is up in world space, and screen pixels count downward, so dir.y must be negative
  const up = screenAxis(c, o, new Vector3(0, 1, 0));
  assert.ok(up.y < -0.99, `+Y should map to negative pixel-y, got ${up.y}`);
}

// --- dragging toward the axis increases the value; away decreases it ---
{
  const c = cam();
  const o = new Vector3(0, 0, 0);

  const right = screenAxis(c, o, new Vector3(1, 0, 0));
  assert.ok(alongAxis(50, 0, right) > 0, 'dragging right must grow an +X handle');
  assert.ok(alongAxis(-50, 0, right) < 0, 'dragging left must shrink an +X handle');

  const up = screenAxis(c, o, new Vector3(0, 1, 0));
  // moving the cursor UP the screen is NEGATIVE dy in client pixels
  assert.ok(alongAxis(0, -50, up) > 0, 'dragging up must grow a +Y handle');
  assert.ok(alongAxis(0, 50, up) < 0, 'dragging down must shrink a +Y handle');
}

// --- one pixel of drag maps back to one pixel of movement ---
{
  const c = cam();
  const o = new Vector3(0, 0, 0);
  const axis = new Vector3(1, 0, 0);
  const perPx = worldPerPixel(c, o, axis, W, H);
  assert.ok(perPx > 0, 'axis across the view must have a scale');

  // move the handle by the world distance a 100px drag implies, and confirm it
  // lands 100px away on screen
  const dir = screenAxis(c, o, axis);
  const world = alongAxis(100, 0, dir) * perPx;
  const moved = new Vector3(world, 0, 0);
  const before = o.clone().project(c);
  const after = moved.project(c);
  const pixelsMoved = ((after.x - before.x) * W) / 2;
  assert.ok(Math.abs(pixelsMoved - 100) < 1, `expected ~100px, moved ${pixelsMoved}`);
}

// --- further away means each pixel covers more world, so distant handles stay 1:1 ---
{
  const c = cam();
  const near = worldPerPixel(c, new Vector3(0, 0, 10), new Vector3(1, 0, 0), W, H);
  const far = worldPerPixel(c, new Vector3(0, 0, -200), new Vector3(1, 0, 0), W, H);
  assert.ok(far > near, 'a pixel must cover more world further from the camera');
}

// --- an axis pointing at the camera has no usable projection ---
{
  const c = cam();
  const degenerate = worldPerPixel(c, new Vector3(0, 0, 0), new Vector3(0, 0, 1), W, H);
  assert.equal(degenerate, 0, 'edge-on axis must report 0 rather than a huge scale');
}

console.log('drag.test.ts: all assertions passed');
