/**
 * The 3D mushroom. Geometry only -- no shaders, no morph targets.
 *
 * profile() is the model: a silhouette in the (radius, height) plane, in real
 * centimetres, revolved with LatheGeometry. Rebuilding it costs microseconds at
 * these vertex counts, which is why a drag can track the pointer exactly instead
 * of interpolating toward a target.
 */
import * as THREE from 'three';
import type { MushroomParams } from './params';

const SEG = 56; // radial segments
const STEPS = 26; // points along the cap surface
const MAX_WARTS = 160;
const MAX_SCALES = 110;
const GILL_COUNT = 60;
const RIDGE_COUNT = 20;
const MAX_TEETH = 220;

/** Fixed pseudo-random unit positions so decorations never jump between frames. */
function seeded(n: number, seed = 1337) {
  let s = seed;
  const out: { u: number; v: number; w: number }[] = [];
  const next = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) out.push({ u: next(), v: next(), w: next() });
  return out;
}
const WART_SPOTS = seeded(MAX_WARTS, 7);
const SCALE_SPOTS = seeded(MAX_SCALES, 99);
const TOOTH_SPOTS = seeded(MAX_TEETH, 4242);

// ---------------------------------------------------------------- the profile

export type Profile = {
  capR: number;
  stemR: number;
  rimY: number;
  centreY: number;
  thickness: number;
  /** Cap upper surface: t=0 at the rim, t=1 at the centre. */
  top: (t: number) => THREE.Vector2;
  /** Cap underside, i.e. the top surface dropped by the cap's thickness. */
  under: (t: number) => THREE.Vector2;
  /** t at a given radius, for meeting the stem to the underside. */
  tAt: (r: number) => number;
  stemTopY: number;
  totalHeight: number;
};

export function profile(p: MushroomParams): Profile {
  const capR = Math.max(p.capDiameter / 2, 0.15);
  const stemR = Math.min(Math.max(p.stemWidth / 2, 0.05), capR * 0.95);
  const c = p.capCurve;
  const H = p.capHeight;
  const rimY = p.stemHeight;
  const centreY = rimY + H * c;
  const thickness = Math.min(Math.max(H * 0.3, 0.1), capR * 0.6);

  // |c| -> 1 straightens the profile into a cone (or a funnel); |c| -> 0 domes it
  const k = 0.5 + 0.5 * Math.abs(c);
  const top = (t: number) =>
    new THREE.Vector2(capR * (1 - t), rimY + (centreY - rimY) * Math.pow(t, k));
  const under = (t: number) => {
    const v = top(t);
    return new THREE.Vector2(v.x, v.y - thickness);
  };
  const tAt = (r: number) => Math.min(1, Math.max(0, 1 - r / capR));
  const stemTopY = under(tAt(stemR)).y;

  return {
    capR, stemR, rimY, centreY, thickness, top, under, tAt, stemTopY,
    totalHeight: Math.max(centreY, rimY) + 0.1,
  };
}

// ---------------------------------------------------------------- piece builders

function capGeometry(pr: Profile): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  for (let i = STEPS; i >= 0; i--) pts.push(pr.top(i / STEPS)); // centre -> rim
  for (let i = 0; i <= STEPS; i++) pts.push(pr.under(i / STEPS)); // rim -> centre
  return new THREE.LatheGeometry(pts, SEG);
}

function stemGeometry(pr: Profile, p: MushroomParams): THREE.BufferGeometry {
  if (p.stemHeight <= 0.05) return new THREE.BufferGeometry();
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, 0)];
  const n = 10;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // slightly bulbous base, tapering to the cap junction
    const r = pr.stemR * (1.18 - 0.18 * Math.pow(t, 0.6));
    pts.push(new THREE.Vector2(r, t * pr.stemTopY));
  }
  pts.push(new THREE.Vector2(0, pr.stemTopY));
  return new THREE.LatheGeometry(pts, SEG);
}

/** The underside surface itself -- carries the pore texture, or shows as smooth. */
function undersideGeometry(pr: Profile): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const v = pr.under(i / STEPS);
    pts.push(new THREE.Vector2(Math.max(v.x, 0.001), v.y - 0.01));
  }
  return new THREE.LatheGeometry(pts, SEG);
}

const INNER_RATIO: Record<string, number> = {
  free: 1.9, adnexed: 1.35, adnate: 1.0, sinuate: 0.92, decurrent: 0.7,
};

/**
 * One gill as a flat ribbon following the cap underside, instanced around the axis.
 * Flat is right here: gills really are thin blades, so a ribbon with DoubleSide
 * reads correctly and costs one quad strip instead of a solid.
 */
function gillGeometry(pr: Profile, p: MushroomParams, blunt: boolean): THREE.BufferGeometry {
  const innerR = Math.min(pr.stemR * (INNER_RATIO[p.gillAttachment] ?? 1), pr.capR * 0.8);
  const outerR = pr.capR * 0.98;
  if (outerR <= innerR) return new THREE.BufferGeometry();
  const maxDepth = Math.min(pr.thickness * (blunt ? 0.5 : 1.15), (outerR - innerR) * 0.45);
  const n = 14;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const r = innerR + (outerR - innerR) * u;
    const yTop = pr.under(pr.tAt(r)).y;
    // deepest in the middle, tapering to nothing at both edges
    const depth = maxDepth * Math.sin(Math.PI * Math.min(1, Math.max(0, u)));
    pos.push(r, yTop, 0, r, yTop - depth, 0);
    if (i < n) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Repeating dot texture for the pore surface, drawn once to a canvas. */
function poreTexture(): THREE.Texture {
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = 'rgba(60,45,30,0.85)';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      ctx.beginPath();
      ctx.arc(x * 8 + 4 + (y % 2) * 4, y * 8 + 4, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// ---------------------------------------------------------------- the mushroom

const lighten = (hex: string, amount: number) =>
  new THREE.Color(hex).lerp(new THREE.Color('#ffffff'), amount);

export class Mushroom {
  readonly group = new THREE.Group();
  /** Public so pointer code can hit-test the body itself, not just the handles. */
  readonly cap = new THREE.Mesh();
  readonly stem = new THREE.Mesh();
  private underside = new THREE.Mesh();
  private gills: THREE.InstancedMesh | null = null;
  private teeth: THREE.InstancedMesh | null = null;
  private warts: THREE.InstancedMesh | null = null;
  private scales: THREE.InstancedMesh | null = null;
  private ring = new THREE.Mesh();
  private volva = new THREE.Mesh();

  private capMat = new THREE.MeshStandardMaterial({ roughness: 0.78, side: THREE.DoubleSide });
  private stemMat = new THREE.MeshStandardMaterial({ roughness: 0.82, side: THREE.DoubleSide });
  private gillMat = new THREE.MeshStandardMaterial({ roughness: 0.9, side: THREE.DoubleSide });
  private wartMat = new THREE.MeshStandardMaterial({ roughness: 0.6 });
  private poreMat: THREE.MeshStandardMaterial;

  profile!: Profile;

  constructor() {
    this.poreMat = new THREE.MeshStandardMaterial({
      roughness: 0.95, side: THREE.DoubleSide, map: poreTexture(),
    });
    this.poreMat.map!.repeat.set(10, 3);
    for (const m of [this.cap, this.stem, this.underside, this.ring, this.volva]) {
      m.castShadow = m.receiveShadow = true;
      this.group.add(m);
    }
    this.cap.material = this.capMat;
    this.stem.material = this.stemMat;
    this.ring.material = this.stemMat;
    this.volva.material = this.stemMat;
  }

  /** Which part of the mushroom a raycast hit belongs to, for direct dragging. */
  partOf(obj: THREE.Object3D): 'cap' | 'stem' | null {
    if (obj === this.cap || obj === this.underside || obj === this.gills || obj === this.teeth) return 'cap';
    if (obj === this.stem || obj === this.ring || obj === this.volva) return 'stem';
    if (obj === this.warts || obj === this.scales) return 'cap';
    return null;
  }

  /** Everything a pointer can grab to resize the mushroom directly. */
  pickTargets(): THREE.Object3D[] {
    return [this.cap, this.stem, this.underside, this.ring, this.volva,
            this.gills, this.teeth, this.warts, this.scales]
      .filter((o): o is THREE.Mesh => Boolean(o) && (o as THREE.Mesh).visible !== false);
  }

  /** Swap a mesh's geometry, disposing the old one. */
  private swap(mesh: THREE.Mesh, geom: THREE.BufferGeometry) {
    mesh.geometry?.dispose();
    mesh.geometry = geom;
  }

  private replaceInstanced(
    current: THREE.InstancedMesh | null,
    geom: THREE.BufferGeometry | null,
    mat: THREE.Material,
    count: number,
  ): THREE.InstancedMesh | null {
    if (current) {
      this.group.remove(current);
      current.geometry.dispose();
    }
    if (!geom || count <= 0) return null;
    const im = new THREE.InstancedMesh(geom, mat, count);
    im.castShadow = true;
    this.group.add(im);
    return im;
  }

  update(p: MushroomParams) {
    const pr = profile(p);
    this.profile = pr;

    this.swap(this.cap, capGeometry(pr));
    this.swap(this.stem, stemGeometry(pr, p));
    this.capMat.color.set(p.capColor);
    this.stemMat.color.set(p.stemColor);
    this.gillMat.color.copy(lighten(p.capColor, 0.45));
    this.wartMat.color.copy(lighten(p.capColor, 0.72));

    // ---- hymenium ----
    const showSurface = p.hymenium === 'pores' || p.hymenium === 'smooth';
    this.underside.visible = showSurface;
    if (showSurface) {
      this.swap(this.underside, undersideGeometry(pr));
      this.underside.material = p.hymenium === 'pores' ? this.poreMat : this.gillMat;
    }

    const bladed = p.hymenium === 'gills' || p.hymenium === 'ridges';
    const bladeCount = p.hymenium === 'ridges' ? RIDGE_COUNT : GILL_COUNT;
    this.gills = this.replaceInstanced(
      this.gills,
      bladed ? gillGeometry(pr, p, p.hymenium === 'ridges') : null,
      this.gillMat,
      bladed ? bladeCount : 0,
    );
    if (this.gills) {
      const m = new THREE.Matrix4();
      for (let i = 0; i < bladeCount; i++) {
        this.gills.setMatrixAt(i, m.makeRotationY((i / bladeCount) * Math.PI * 2));
      }
      this.gills.instanceMatrix.needsUpdate = true;
    }

    // ---- teeth: cones hanging from the underside ----
    const toothLen = Math.min(pr.thickness * 1.6, pr.capR * 0.35);
    const toothR = Math.max(pr.capR * 0.022, 0.015);
    const nTeeth = p.hymenium === 'teeth' ? MAX_TEETH : 0;
    this.teeth = this.replaceInstanced(
      this.teeth,
      nTeeth ? new THREE.ConeGeometry(toothR, toothLen, 5) : null,
      this.gillMat,
      nTeeth,
    );
    if (this.teeth) {
      const m = new THREE.Matrix4();
      const innerR = Math.min(pr.stemR * 1.2, pr.capR * 0.5);
      for (let i = 0; i < nTeeth; i++) {
        const s = TOOTH_SPOTS[i];
        // sqrt keeps the scatter even per unit area rather than clumped at the centre
        const r = innerR + (pr.capR * 0.95 - innerR) * Math.sqrt(s.u);
        const a = s.v * Math.PI * 2;
        const y = pr.under(pr.tAt(r)).y - toothLen / 2;
        m.makeRotationX(Math.PI); // point downward
        m.setPosition(Math.cos(a) * r, y, Math.sin(a) * r);
        this.teeth.setMatrixAt(i, m);
      }
      this.teeth.instanceMatrix.needsUpdate = true;
    }

    // ---- warts on the cap ----
    const nWarts = Math.round(p.warts * MAX_WARTS);
    const wartR = Math.max(pr.capR * 0.045, 0.02);
    this.warts = this.replaceInstanced(
      this.warts,
      nWarts ? new THREE.SphereGeometry(wartR, 7, 5) : null,
      this.wartMat,
      nWarts,
    );
    if (this.warts) {
      const m = new THREE.Matrix4();
      for (let i = 0; i < nWarts; i++) {
        const s = WART_SPOTS[i];
        const t = Math.pow(s.u, 0.7); // bias away from the extreme rim
        const v = pr.top(t);
        const a = s.v * Math.PI * 2;
        const sc = 0.55 + s.w * 0.75;
        m.makeScale(sc, sc * 0.72, sc);
        m.setPosition(Math.cos(a) * v.x, v.y + wartR * 0.25, Math.sin(a) * v.x);
        this.warts.setMatrixAt(i, m);
      }
      this.warts.instanceMatrix.needsUpdate = true;
    }

    // ---- scales: flattened, tilted plates on the cap ----
    const nScales = Math.round(p.scales * MAX_SCALES);
    const scaleSize = Math.max(pr.capR * 0.13, 0.05);
    this.scales = this.replaceInstanced(
      this.scales,
      nScales ? new THREE.ConeGeometry(scaleSize, scaleSize * 1.5, 4) : null,
      this.wartMat,
      nScales,
    );
    if (this.scales) {
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const pos = new THREE.Vector3();
      const one = new THREE.Vector3(1, 0.45, 1);
      for (let i = 0; i < nScales; i++) {
        const s = SCALE_SPOTS[i];
        const t = Math.pow(s.u, 0.65);
        const v = pr.top(t);
        const a = s.v * Math.PI * 2;
        e.set(-0.5 - s.w * 0.4, a, 0);
        q.setFromEuler(e);
        pos.set(Math.cos(a) * v.x, v.y + scaleSize * 0.18, Math.sin(a) * v.x);
        m.compose(pos, q, one);
        this.scales.setMatrixAt(i, m);
      }
      this.scales.instanceMatrix.needsUpdate = true;
    }

    // ---- ring and volva ----
    this.ring.visible = p.ring && p.stemHeight > 0.6;
    if (this.ring.visible) {
      const rr = pr.stemR * 1.75;
      this.swap(this.ring, new THREE.TorusGeometry(rr, rr * 0.22, 8, SEG));
      this.ring.rotation.x = Math.PI / 2;
      this.ring.position.y = pr.stemTopY * 0.72;
    }

    this.volva.visible = p.volva && p.stemHeight > 0.4;
    if (this.volva.visible) {
      const h = Math.min(pr.stemTopY * 0.3, pr.stemR * 3.2);
      const pts: THREE.Vector2[] = [];
      const n = 10;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        pts.push(new THREE.Vector2(pr.stemR * (1.95 - 0.6 * t * t), t * h));
      }
      this.swap(this.volva, new THREE.LatheGeometry(pts, SEG));
    }
  }
}
