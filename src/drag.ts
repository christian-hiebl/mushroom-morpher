/**
 * Screen-space maths for the drag handles, kept pure and separate so it can be
 * tested without a browser. This is the part that decides whether a handle tracks
 * the cursor one-to-one or drifts away from it.
 */
import type { PerspectiveCamera, Vector3 } from 'three';
import { Vector2, Vector3 as V3 } from 'three';

/**
 * Direction the axis points on screen, in client-pixel orientation (x right,
 * y DOWN). NDC y points up, hence the negation -- matching conventions here lets
 * the caller project a pointer delta with a plain dot product.
 */
export function screenAxis(camera: PerspectiveCamera, origin: Vector3, axis: Vector3): Vector2 {
  const a = origin.clone().project(camera);
  const b = new V3().copy(origin).add(axis).project(camera);
  const v = new Vector2(b.x - a.x, -(b.y - a.y));
  return v.lengthSq() > 1e-12 ? v.normalize() : new Vector2(1, 0);
}

/**
 * World units covered by one screen pixel along `axis`, at the handle's depth.
 * Returns 0 when the axis points almost straight at the camera (no usable
 * screen projection), so the caller leaves the value alone instead of jumping.
 */
export function worldPerPixel(
  camera: PerspectiveCamera, origin: Vector3, axis: Vector3, width: number, height: number,
): number {
  const a = origin.clone().project(camera);
  const b = new V3().copy(origin).add(axis).project(camera);
  const pixels = Math.hypot(((b.x - a.x) * width) / 2, ((b.y - a.y) * height) / 2);
  return pixels > 0.5 ? 1 / pixels : 0;
}

/** Pointer delta (client pixels) projected onto the handle's screen axis. */
export const alongAxis = (dx: number, dy: number, dir: Vector2) => dx * dir.x + dy * dir.y;
