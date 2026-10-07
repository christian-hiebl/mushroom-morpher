/**
 * Scene, drag handles, control panel and the live match column.
 *
 * All state lives in one `params` object. setParam() mutates it and schedules a
 * single rAF that rebuilds the geometry and re-ranks the species. Ranking 100
 * species over ~10 traits is far under a millisecond, so it runs every frame with
 * no debounce -- the match column tracks the drag as tightly as the mesh does.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { alongAxis, screenAxis, worldPerPixel } from './drag';
import { Mushroom, profile } from './mushroom';
import { wikiThumb, type ThumbWidth } from './photo';
import {
  matchedCommonName, rank, search, speciesToParams, unknownTraits,
  type Match, type SizeVariant, type Species,
} from './match';
import {
  ATTACHMENTS, DEFAULTS, ECOLOGIES, HABITATS, HYMENIA, LIMITS, PALETTE, REGIONS, SEASONS, SPORE_PRINTS,
  clamp, shapeName,
  type Ecology, type GillAttachment, type Hymenium, type MushroomParams, type NumericKey,
} from './params';

/**
 * Empty until the data chunk arrives. It is imported dynamically (see the end
 * of this file) so the scene paints without waiting on ~900 KB of species data.
 */
let species: Species[] = [];

/**
 * Never assign a URL from the data file to href or src without checking it.
 *
 * Everything in species.json is derived from Wikipedia, which anyone can edit,
 * so it is untrusted input even though the build pipeline already filters it.
 * A `javascript:` href executes on click, so this is the one place a bad value
 * in the data could become script execution. Defence in depth: the build only
 * stores https URLs, and the app refuses anything else anyway.
 */
function safeUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url, location.href).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** Show a Wikimedia photo as a thumbnail, falling back to the original once. */
function setPhoto(img: HTMLImageElement, url: string, width: ThumbWidth) {
  img.onerror = () => { img.onerror = null; img.src = url; };
  img.src = wikiThumb(url, width);
}
const params: MushroomParams = { ...DEFAULTS };

/** The where-and-when traits: param key and its fixed vocabulary. */
const WHERE: ['season' | 'region' | 'habitat', readonly string[]][] = [
  ['season', SEASONS], ['region', REGIONS], ['habitat', HABITATS],
];

/**
 * The shape lives in the URL hash, so a mushroom you built can be linked, bookmarked
 * and reloaded. Unknown or malformed keys are ignored rather than throwing -- a
 * hand-edited URL should degrade to the default mushroom, never a blank page.
 */
/** Species named in the URL, resolved once the dataset and UI exist. */
let pendingBuilt: string | null = null;
let pendingSize: SizeVariant = 'medium';
let pendingCompare: string[] = [];

function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  for (const [k, raw] of q) {
    if (!(k in DEFAULTS)) continue;
    const key = k as keyof MushroomParams;
    const current = DEFAULTS[key];
    if (typeof current === 'number') {
      const n = Number(raw);
      if (Number.isFinite(n)) (params[key] as number) = (k in LIMITS) ? clamp(k as NumericKey, n) : n;
    } else if (typeof current === 'boolean') {
      (params[key] as boolean) = raw === '1' || raw === 'true';
    } else {
      // sporePrint and ecology default to null, so an empty value clears them
      (params[key] as string | null) = raw || null;
    }
  }
  pendingBuilt = q.get('built');
  pendingSize = (q.get('size') as SizeVariant | null) ?? 'medium';
  pendingCompare = (q.get('cmp') ?? '').split('|').filter(Boolean);
  // a bad enum would render nothing, so fall back rather than trust the URL
  if (!HYMENIA.some((h) => h.value === params.hymenium)) params.hymenium = DEFAULTS.hymenium;
  if (!ATTACHMENTS.includes(params.gillAttachment)) params.gillAttachment = DEFAULTS.gillAttachment;
  if (params.sporePrint && !SPORE_PRINTS.includes(params.sporePrint)) params.sporePrint = null;
  if (params.ecology && !ECOLOGIES.some((e) => e.value === params.ecology)) params.ecology = null;
  for (const [k, vocab] of WHERE) {
    if (params[k] && !vocab.includes(params[k]!)) params[k] = null;
  }
  for (const k of ['capColor', 'stemColor'] as const) {
    if (!/^#[0-9a-f]{6}$/i.test(params[k])) params[k] = DEFAULTS[k];
  }
}

function writeHash() {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === DEFAULTS[k as keyof MushroomParams]) continue; // keep the URL short
    q.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v));
  }
  // a built species and its comparison set travel with the link
  if (built) { q.set('built', built.name); q.set('size', size); }
  if (comparison.length) q.set('cmp', comparison.map((s) => s.name).join('|'));
  history.replaceState(null, '', q.toString() ? `#${q}` : location.pathname);
}
readHash();

// ---------------------------------------------------------------- scene

const canvasWrap = document.getElementById('stage')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
canvasWrap.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 2000);
/**
 * Low elevation on purpose. Looking down at the cap hides the entire underside,
 * which is the single most important thing you can change -- switching gills to
 * pores then looks like nothing happened.
 */
camera.position.set(12, 5.5, 20);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 2;
controls.maxDistance = 400;
controls.maxPolarAngle = Math.PI * 0.52;

scene.add(new THREE.HemisphereLight(0xdfe9f2, 0x4a4036, 1.15));
const sun = new THREE.DirectionalLight(0xfff3e0, 1.5);
sun.position.set(12, 22, 9);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = sun.shadow.camera.bottom = -40;
sun.shadow.camera.right = sun.shadow.camera.top = 40;
scene.add(sun);

/**
 * 1 cm grid -- the size readout you can actually see, since the camera auto-frames
 * and the mushroom therefore looks the same size whatever you set. Kept modest and
 * fogged: a grid large enough to reach the horizon draws a hard band across the view.
 */
const GRID_CM = 60;
const grid = new THREE.GridHelper(GRID_CM, GRID_CM, 0x7d8a73, 0x4a5543);
(grid.material as THREE.Material).opacity = 0.45;
(grid.material as THREE.Material).transparent = true;
scene.add(grid);
scene.fog = new THREE.Fog(0x14171a, 20, 90);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 600),
  new THREE.ShadowMaterial({ opacity: 0.22 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.01;
ground.receiveShadow = true;
scene.add(ground);

const mushroom = new Mushroom();
scene.add(mushroom.group);

// ---------------------------------------------------------------- drag handles

type Handle = {
  key: NumericKey;
  /** Where the handle sits, in cm, from the current profile. */
  at: (pr: ReturnType<typeof profile>) => THREE.Vector3;
  /** World-space direction that increases the value. */
  axis: THREE.Vector3;
  /** cm per unit of world movement along the axis. */
  gain: number;
  label: string;
};

const HANDLES: Handle[] = [
  {
    key: 'capDiameter', label: 'cap width',
    at: (pr) => new THREE.Vector3(pr.capR, pr.rimY, 0),
    axis: new THREE.Vector3(1, 0, 0), gain: 2, // radius -> diameter
  },
  {
    key: 'capHeight', label: 'cap height',
    at: (pr) => new THREE.Vector3(0, Math.max(pr.centreY, pr.rimY) + 0.1, 0),
    axis: new THREE.Vector3(0, 1, 0), gain: 1,
  },
  {
    key: 'capCurve', label: 'cap curve',
    at: (pr) => new THREE.Vector3(pr.capR * 0.52, pr.top(0.48).y, 0),
    axis: new THREE.Vector3(0, 1, 0), gain: 0.25,
  },
  {
    key: 'stemHeight', label: 'stem length',
    at: (pr) => new THREE.Vector3(pr.stemR * 1.1, pr.stemTopY * 0.66, 0),
    axis: new THREE.Vector3(0, 1, 0), gain: 2,
  },
  {
    key: 'stemWidth', label: 'stem width',
    at: (pr) => new THREE.Vector3(pr.stemR, pr.stemTopY * 0.14, 0),
    axis: new THREE.Vector3(1, 0, 0), gain: 2,
  },
];

const handleMat = new THREE.MeshBasicMaterial({ color: 0xffd166 });
const handleHot = new THREE.MeshBasicMaterial({ color: 0xff8c42 });
const handleMeshes: THREE.Mesh[] = HANDLES.map(() => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), handleMat);
  m.renderOrder = 2;
  scene.add(m);
  return m;
});

/**
 * Invisible, much larger spheres that actually receive the raycast. A 'visible'
 * dot big enough to hit comfortably would dominate the model, so the grab area
 * and the drawn dot are separate. opacity 0 rather than visible:false, because
 * the raycaster skips invisible objects.
 */
const PICK_SCALE = 1.9;
const pickMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
const pickMeshes: THREE.Mesh[] = HANDLES.map(() => {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), pickMat);
  scene.add(m);
  return m;
});

function layoutHandles() {
  const pr = mushroom.profile;
  // constant on-screen size regardless of how big the mushroom is
  const s = camera.position.distanceTo(controls.target) * 0.0115;
  HANDLES.forEach((h, i) => {
    const at = h.at(pr);
    handleMeshes[i].position.copy(at);
    handleMeshes[i].scale.setScalar(s);
    pickMeshes[i].position.copy(at);
    pickMeshes[i].scale.setScalar(s * PICK_SCALE);
  });
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
type Drag = {
  h: Handle;
  mesh: THREE.Mesh;
  start: number;
  startPx: THREE.Vector2;
  perPx: number;
  /** Axis direction in client-pixel orientation (x right, y down). */
  dir: THREE.Vector2;
};
let drag: Drag | null = null;

/**
 * Dragging the body itself, not a handle. Horizontal movement changes the part's
 * width, vertical changes its height -- so grabbing the cap and pulling outward
 * widens it, exactly as if the whole shape were the handle.
 */
type BodyDrag = {
  part: 'cap' | 'stem';
  startPx: THREE.Vector2;
  startW: number;
  startH: number;
  perPxX: number;
  perPxY: number;
  dirX: THREE.Vector2;
  dirY: THREE.Vector2;
};
let bodyDrag: BodyDrag | null = null;

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

const toNDC = (e: PointerEvent) => {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
};

renderer.domElement.addEventListener('pointerdown', (e) => {
  toNDC(e);
  raycaster.setFromCamera(pointer, camera);

  const hit = raycaster.intersectObjects(pickMeshes, false)[0];
  if (!hit) {
    // no handle under the pointer -- try the mushroom body itself
    const bodyHit = raycaster.intersectObjects(mushroom.pickTargets(), false)[0];
    const part = bodyHit && mushroom.partOf(bodyHit.object);
    if (part) {
      const at = bodyHit.point.clone();
      const w = renderer.domElement.clientWidth;
      const hgt = renderer.domElement.clientHeight;
      bodyDrag = {
        part,
        startPx: new THREE.Vector2(e.clientX, e.clientY),
        startW: part === 'cap' ? params.capDiameter : params.stemWidth,
        startH: part === 'cap' ? params.capHeight : params.stemHeight,
        perPxX: worldPerPixel(camera, at, X_AXIS, w, hgt),
        perPxY: worldPerPixel(camera, at, Y_AXIS, w, hgt),
        dirX: screenAxis(camera, at, X_AXIS),
        dirY: screenAxis(camera, at, Y_AXIS),
      };
      controls.enabled = false;
      renderer.domElement.setPointerCapture(e.pointerId);
      setStatus(part === 'cap' ? 'cap: drag to resize' : 'stem: drag to resize');
    }
    return; // otherwise leave it to OrbitControls
  }

  const i = pickMeshes.indexOf(hit.object as THREE.Mesh);
  const h = HANDLES[i];
  const origin = handleMeshes[i].position.clone();
  drag = {
    h,
    mesh: handleMeshes[i],
    start: params[h.key],
    startPx: new THREE.Vector2(e.clientX, e.clientY),
    perPx: worldPerPixel(camera, origin, h.axis, renderer.domElement.clientWidth, renderer.domElement.clientHeight),
    dir: screenAxis(camera, origin, h.axis),
  };
  drag.mesh.material = handleHot;
  controls.enabled = false; // orbit must not fight the drag
  renderer.domElement.setPointerCapture(e.pointerId);
  setStatus(`${h.label}: drag`);
});

renderer.domElement.addEventListener('pointermove', (e) => {
  if (bodyDrag) {
    const dx = e.clientX - bodyDrag.startPx.x;
    const dy = e.clientY - bodyDrag.startPx.y;
    const dW = alongAxis(dx, dy, bodyDrag.dirX) * bodyDrag.perPxX * 2; // radius -> diameter
    const dH = alongAxis(dx, dy, bodyDrag.dirY) * bodyDrag.perPxY;
    if (bodyDrag.part === 'cap') {
      setParam('capDiameter', bodyDrag.startW + dW);
      setParam('capHeight', bodyDrag.startH + dH);
    } else {
      setParam('stemWidth', bodyDrag.startW + dW);
      setParam('stemHeight', bodyDrag.startH + dH);
    }
    return;
  }
  if (!drag) {
    toNDC(e);
    raycaster.setFromCamera(pointer, camera);
    const onHandle = raycaster.intersectObjects(pickMeshes, false).length > 0;
    const onBody = !onHandle && raycaster.intersectObjects(mushroom.pickTargets(), false).length > 0;
    renderer.domElement.style.cursor = onHandle ? 'grab' : onBody ? 'move' : 'default';
    return;
  }
  // both vectors are in client-pixel orientation, so this is just a projection
  const dx = e.clientX - drag.startPx.x;
  const dy = e.clientY - drag.startPx.y;
  const along = alongAxis(dx, dy, drag.dir);
  setParam(drag.h.key, drag.start + along * drag.perPx * drag.h.gain);
});

const endDrag = () => {
  if (bodyDrag) {
    bodyDrag = null;
    controls.enabled = true;
    setStatus('');
  }
  if (!drag) return;
  drag.mesh.material = handleMat;
  drag = null;
  controls.enabled = true;
  setStatus('');
};
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);

// ---------------------------------------------------------------- state plumbing

let dirty = true;
let hashPending = false;
/**
 * Assigned by the search section below. Hand-editing the shape means the model
 * is no longer the species that was built, so the workbench label must clear --
 * but this runs on every pointermove during a drag, so it guards on itself.
 */
let releaseBuilt: () => void = () => {};
function setParam<K extends keyof MushroomParams>(k: K, v: MushroomParams[K]) {
  releaseBuilt(); // the shape is being edited by hand; it is no longer a named species
  if (typeof v === 'number' && (k as string) in LIMITS) {
    params[k] = clamp(k as NumericKey, v) as MushroomParams[K];
  } else {
    params[k] = v;
  }
  dirty = true;
  syncInputs();
}

const statusEl = document.getElementById('status')!;
const setStatus = (t: string) => {
  statusEl.textContent = t;
  statusEl.style.display = t ? 'block' : 'none';
};
setStatus('');

// ---------------------------------------------------------------- control panel

const controlsEl = document.getElementById('controls')!;

// Mobile: the panel is a collapsed <details>, the handles on the mushroom still
// work. Desktop: always open (its summary is hidden in CSS).
const modsEl = document.getElementById('mods') as HTMLDetailsElement;
const mobileQuery = matchMedia('(max-width: 760px)');
const syncMods = () => { modsEl.open = !mobileQuery.matches; };
mobileQuery.addEventListener('change', syncMods);
syncMods();
const inputs: { el: HTMLInputElement; key: NumericKey; out: HTMLElement }[] = [];
const swatchNames: Partial<Record<'capColor' | 'stemColor', HTMLElement>> = {};

function slider(key: NumericKey, label: string, step: number, unit: string) {
  const row = document.createElement('label');
  row.className = 'row';
  const [lo, hi] = LIMITS[key];
  row.innerHTML = `<span class="rowlabel">${label}<output></output></span>`;
  const el = document.createElement('input');
  el.type = 'range';
  el.min = String(lo);
  el.max = String(hi);
  el.step = String(step);
  el.setAttribute('aria-label', label);
  el.addEventListener('input', () => setParam(key, Number(el.value)));
  row.appendChild(el);
  section.appendChild(row);
  const out = row.querySelector('output')!;
  inputs.push({ el, key, out });
  (out as any)._unit = unit;
}

/** The section new controls are added to; group() starts the next one. */
let section: HTMLElement = controlsEl;
/** A collapsible section: native <details>, open by default. */
function group(title: string) {
  section = document.createElement('details');
  (section as HTMLDetailsElement).open = true;
  const h = document.createElement('summary');
  h.textContent = title;
  section.appendChild(h);
  controlsEl.appendChild(section);
}

group('Cap');
slider('capDiameter', 'Width', 0.1, 'cm');
slider('capHeight', 'Height', 0.1, 'cm');
slider('capCurve', 'Curve', 0.01, '');
group('Stem');
slider('stemHeight', 'Length', 0.1, 'cm');
slider('stemWidth', 'Width', 0.05, 'cm');

// colours: a fixed palette of real mushroom colours rather than a free wheel
const swatchButtons: Record<'capColor' | 'stemColor', HTMLButtonElement[]> = {
  capColor: [], stemColor: [],
};
{
  group('Colour');
  for (const [key, label] of [['capColor', 'Cap'], ['stemColor', 'Stem']] as const) {
    const title = document.createElement('p');
    title.className = 'swatchlabel';
    title.innerHTML = `${label} <span></span>`;
    section.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'palette';
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', `${label} colour`);
    for (const sw of PALETTE) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sw';
      b.style.background = sw.hex;
      b.title = sw.name;
      b.setAttribute('aria-label', `${label}: ${sw.name}`);
      b.addEventListener('click', () => setParam(key, sw.hex));
      grid.appendChild(b);
      swatchButtons[key].push(b);
    }
    section.appendChild(grid);
    swatchNames[key] = title.querySelector('span')!;
  }
}

// underside
group('Underside');
const hymButtons: Partial<Record<Hymenium, HTMLButtonElement>> = {};
{
  const wrap = document.createElement('div');
  wrap.className = 'chips';
  for (const h of HYMENIA) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = h.label;
    b.title = h.hint;
    b.addEventListener('click', () => setParam('hymenium', h.value));
    wrap.appendChild(b);
    hymButtons[h.value] = b;
  }
  section.appendChild(wrap);
}

const attachWrap = document.createElement('div');
attachWrap.className = 'chips sub';
const attachButtons: Partial<Record<GillAttachment, HTMLButtonElement>> = {};
for (const a of ATTACHMENTS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = a;
  b.addEventListener('click', () => setParam('gillAttachment', a));
  attachWrap.appendChild(b);
  attachButtons[a] = b;
}
section.appendChild(attachWrap);

// surface
group('Surface');
slider('warts', 'Warts', 0.01, '');
slider('scales', 'Scales', 0.01, '');
const toggles: Partial<Record<'ring' | 'volva', HTMLInputElement>> = {};
{
  const wrap = document.createElement('div');
  wrap.className = 'chips';
  for (const [key, label] of [['ring', 'Ring'], ['volva', 'Volva']] as const) {
    const l = document.createElement('label');
    l.className = 'toggle';
    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.addEventListener('change', () => setParam(key, inp.checked));
    l.append(inp, document.createTextNode(label));
    wrap.appendChild(l);
    toggles[key] = inp;
  }
  section.appendChild(wrap);
}

/**
 * Spore print and ecology are invisible on the model, so they are plain inputs
 * rather than handles -- but they are recorded for ~92% of species and are the
 * strongest discriminators once shape and colour agree. Both default to
 * "unknown", which is not scored: a beginner has not taken a spore print.
 */
group('Spore print & ecology');
const sporeSelect = document.createElement('select');
{
  const row = document.createElement('label');
  row.className = 'row';
  row.innerHTML = '<span class="rowlabel">Spore print</span>';
  sporeSelect.setAttribute('aria-label', 'Spore print colour');
  const any = document.createElement('option');
  any.value = '';
  any.textContent = "don't know / any";
  sporeSelect.appendChild(any);
  for (const v of SPORE_PRINTS) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    sporeSelect.appendChild(o);
  }
  sporeSelect.addEventListener('change', () =>
    setParam('sporePrint', sporeSelect.value || null));
  row.appendChild(sporeSelect);
  section.appendChild(row);
}

const ecoButtons: Record<string, HTMLButtonElement> = {};
{
  const wrap = document.createElement('div');
  wrap.className = 'chips';
  const mk = (value: Ecology | null, label: string, hint: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = hint;
    b.addEventListener('click', () => setParam('ecology', value));
    wrap.appendChild(b);
    ecoButtons[value ?? ''] = b;
  };
  mk(null, 'any', 'not specified');
  for (const e of ECOLOGIES) mk(e.value, e.value, e.hint);
  section.appendChild(wrap);
}

/**
 * Season, region and habitat are read from each article's prose by keyword, so
 * they are weaker evidence than the traits above and weigh half as much. Like
 * spore print they default to "any", which is not scored.
 */
group('Where & when');
const whereButtons: Record<string, Record<string, HTMLButtonElement>> = {};
for (const [key, vocab] of WHERE) {
  const title = document.createElement('div');
  title.className = 'swatchlabel';
  title.textContent = key[0].toUpperCase() + key.slice(1);
  const wrap = document.createElement('div');
  wrap.className = 'chips';
  whereButtons[key] = {};
  for (const value of [null, ...vocab]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = value ?? 'any';
    b.addEventListener('click', () => setParam(key, value));
    wrap.appendChild(b);
    whereButtons[key][value ?? ''] = b;
  }
  section.append(title, wrap);
}

document.getElementById('reset')!.addEventListener('click', () => {
  Object.assign(params, DEFAULTS);
  releaseBuilt();
  dirty = true;
  syncInputs();
});

addEventListener('hashchange', () => {
  Object.assign(params, DEFAULTS);
  readHash();
  dirty = true;
  syncInputs();
});

function syncInputs() {
  for (const { el, key, out } of inputs) {
    const v = params[key];
    if (document.activeElement !== el) el.value = String(v);
    const unit = (out as any)._unit;
    out.textContent = key === 'capCurve'
      ? ` ${shapeName(v)}`
      : unit ? ` ${v.toFixed(unit === 'cm' ? 1 : 2)} ${unit}` : ` ${v.toFixed(2)}`;
  }
  for (const h of HYMENIA) hymButtons[h.value]!.classList.toggle('on', params.hymenium === h.value);
  for (const a of ATTACHMENTS) attachButtons[a]!.classList.toggle('on', params.gillAttachment === a);
  attachWrap.classList.toggle('hidden', params.hymenium !== 'gills');
  toggles.ring!.checked = params.ring;
  toggles.volva!.checked = params.volva;
  if (document.activeElement !== sporeSelect) sporeSelect.value = params.sporePrint ?? '';
  for (const [k, b] of Object.entries(ecoButtons)) {
    b.classList.toggle('on', (params.ecology ?? '') === k);
  }
  for (const [key] of WHERE) {
    for (const [k, b] of Object.entries(whereButtons[key])) b.classList.toggle('on', (params[key] ?? '') === k);
  }
  for (const key of ['capColor', 'stemColor'] as const) {
    const current = params[key].toLowerCase();
    PALETTE.forEach((sw, i) => {
      swatchButtons[key][i].classList.toggle('on', sw.hex.toLowerCase() === current);
    });
    const match = PALETTE.find((sw) => sw.hex.toLowerCase() === current);
    swatchNames[key]!.textContent = match ? match.name : '';
  }
}

// ---------------------------------------------------------------- match column

const matchesEl = document.getElementById('matches')!;

const EDIBILITY_CLASS: Record<string, string> = {
  deadly: 'danger', poisonous: 'danger', allergenic: 'warn', caution: 'warn',
  psychoactive: 'warn', 'not recommended': 'warn', inedible: 'muted',
  unpalatable: 'muted', 'too hard to eat': 'muted', unknown: 'muted',
  edible: 'good', choice: 'good',
};
/** Most severe edibility wins the card's accent colour. */
const SEVERITY = ['danger', 'warn', 'good', 'muted'];
const worstClass = (edibility: string[]) =>
  SEVERITY.find((c) => edibility.some((e) => EDIBILITY_CLASS[e] === c)) ?? 'muted';

/**
 * Three cards built once and updated in place. Rebuilding the DOM every frame
 * recreated the <img> elements on each pointermove, which made the photos flicker
 * during a drag; mutating only what changed keeps it still.
 */
type Card = {
  root: HTMLElement; img: HTMLImageElement; pct: HTMLElement; cover: HTMLElement;
  name: HTMLAnchorElement; buildBtn: HTMLButtonElement;
  badges: HTMLElement; traits: HTMLElement; credit: HTMLElement; key: string;
  /** Which species this card currently shows, for opening its slideshow. */
  species: Species | null;
};

const MATCH_COUNT = 5;
/**
 * Built with an explicit loop, not Array.from(...). Rollup treats Array.from as
 * a pure builtin and discarded the side effects inside the callback -- which
 * included each card's click listener. That silently removed openGallery from
 * the production bundle, so the slideshow worked in dev and did nothing on the
 * built site.
 */
const cards: Card[] = [];
for (let i = 0; i < MATCH_COUNT; i++) {
  const root = document.createElement('article');
  root.className = 'match';
  root.innerHTML = `
    <img alt="" loading="${i === 0 ? 'eager' : 'lazy'}">
    <div class="mbody">
      <div class="mhead"><span class="rank">#${i + 1}</span>
        <span class="cover"></span><span class="pct"></span></div>
      <h4><a target="_blank" rel="noopener noreferrer"></a></h4>
      <div class="badges"></div>
      <button type="button" class="buildme">Build me</button>
      <ul class="traits"></ul>
      <p class="credit"></p>
    </div>`;
  matchesEl.appendChild(root);
  const card: Card = {
    root,
    img: root.querySelector('img')!,
    pct: root.querySelector<HTMLElement>('.pct')!,
    cover: root.querySelector<HTMLElement>('.cover')!,
    name: root.querySelector<HTMLAnchorElement>('h4 a')!,
    buildBtn: root.querySelector<HTMLButtonElement>('.buildme')!,
    badges: root.querySelector<HTMLElement>('.badges')!,
    traits: root.querySelector<HTMLElement>('.traits')!,
    credit: root.querySelector<HTMLElement>('.credit')!,
    key: '',
    species: null,
  };
  card.img.addEventListener('click', () => {
    if (card.species) openGallery(card.species, card.img);
  });
  card.buildBtn.addEventListener('click', () => {
    if (!card.species) return;
    chooseSpecies(card.species);
    // on a phone the cards sit below the model, so bring the result into view
    canvasWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  root.hidden = true; // nothing to show until the species data has loaded
  cards.push(card);
}

function renderMatches(top: Match[]) {
  top.forEach((m, i) => {
    const c = cards[i];
    const s = m.species;
    c.pct.textContent = `${m.score.toFixed(0)}%`;
    // how much is actually known about this species, so a 100% from three
    // traits is never mistaken for a 100% from nine
    const scored = m.traits.length;
    c.cover.textContent = `on ${scored} trait${scored === 1 ? '' : 's'}`;
    c.cover.title =
      `Matched on ${scored} of the traits this species records. ` +
      `Traits its article never states are not scored either way.`;

    c.root.hidden = false;
    c.buildBtn.disabled = built === s;
    c.buildBtn.textContent = built === s ? 'Built' : 'Build me';

    // everything below depends only on which species it is, not on the score
    c.species = s;
    if (c.key !== s.name) {
      c.key = s.name;
      // not every species page has a lead photo; show a placeholder rather than
      // a broken image box
      const photo = safeUrl(s.image?.url);
      if (photo) {
        setPhoto(c.img, photo, 500);
        c.img.alt = s.name;
        c.img.classList.remove('noimg');
      } else {
        c.img.onerror = null;
        c.img.removeAttribute('src');
        c.img.alt = '';
        c.img.classList.add('noimg');
      }
      c.name.textContent = s.name;
      const article = safeUrl(s.url);
      if (article) {
        c.name.href = article;
      } else {
        c.name.removeAttribute('href');
      }
      c.badges.replaceChildren(...s.edibility.map((e) => {
        const b = document.createElement('span');
        b.className = `badge ${EDIBILITY_CLASS[e] ?? 'muted'}`;
        b.textContent = e;
        return b;
      }));
      if (s.image) {
        const credit = `photo: ${s.image.artist} \u00b7 ${s.image.license} \u00b7 `;
        const source = safeUrl(s.image.page);
        if (source) {
          const link = document.createElement('a');
          link.href = source;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = 'Wikimedia Commons';
          link.addEventListener('click', (e) => e.stopPropagation());
          c.credit.replaceChildren(document.createTextNode(credit), link);
        } else {
          c.credit.textContent = `${credit}Wikimedia Commons`;
        }
      } else {
        c.credit.textContent = 'no verified photo for this species';
      }
      c.root.className = `match ${worstClass(s.edibility)}`;
    }

    // trait rows do change as you drag, so rebuild just these
    c.traits.replaceChildren(...m.traits
      .slice()
      .sort((a, b) => b.sim - a.sim)
      .map((t) => {
        const li = document.createElement('li');
        li.className = t.sim > 0.75 ? 'hit' : t.sim > 0.4 ? 'near' : 'miss';
        const l = document.createElement('span');
        l.textContent = t.label;
        const v = document.createElement('span');
        v.className = 'tval';
        v.textContent = t.detail;
        li.append(l, v);
        return li;
      }));
  });
}

// ---------------------------------------------------------------- species search

/**
 * Type a species name -- scientific or English -- and the model is rebuilt from
 * that species' recorded traits, the inverse of the matcher. Traits the article
 * never recorded fall back to the default mushroom rather than being invented,
 * so a sparsely documented species yields an honest approximation.
 */

/** The species currently on the workbench, and at which end of its size range. */
let built: Species | null = null;
let size: SizeVariant = 'medium';
/** Species parked for comparison. Only one is ever rendered; the chips switch. */
const comparison: Species[] = [];

const workbench = document.getElementById('workbench')!;
const builtName = document.getElementById('builtname')!;
const builtCommon = document.getElementById('builtcommon')!;
const builtDims = document.getElementById('builtdims')!;
const addCompareBtn = document.getElementById('addcompare') as HTMLButtonElement;
const compareBar = document.getElementById('comparebar')!;
const compareChips = document.getElementById('comparechips')!;
const sizeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.sizes button'));

const fmt = (r: [number, number] | null) => (r ? `${r[0]}\u2013${r[1]} cm` : 'not recorded');

/** Apply a species to the 3D model at the current size variant. */
function build(sp: Species, variant: SizeVariant = size) {
  size = variant;
  // assign directly rather than via setParam, which would clear `built`
  Object.assign(params, speciesToParams(sp, variant));
  built = sp;
  dirty = true;
  syncInputs();
  renderWorkbench();
}

/** Build a species the user picked: from search, a match card or Surprise me. */
function chooseSpecies(sp: Species) {
  build(sp, 'medium');
  (document.getElementById('search') as HTMLInputElement).value = sp.name;
  setStatus(`built ${sp.name}`);
  setTimeout(() => setStatus(''), 2200);
}

function renderWorkbench() {
  workbench.hidden = !built && comparison.length === 0;
  if (built) {
    builtName.textContent = built.name;
    const common = built.common?.[0];
    builtCommon.textContent = common ? `\u2014 ${common}` : '';
    // say plainly which end of the recorded range this model represents
    builtDims.textContent =
      `${size} specimen \u00b7 cap ${params.capDiameter.toFixed(1)} cm of ${fmt(built.capCm)}` +
      (built.stemCm ? ` \u00b7 stem ${params.stemHeight.toFixed(1)} cm of ${fmt(built.stemCm)}` : '');
    addCompareBtn.disabled = comparison.some((s) => s.name === built!.name);
    addCompareBtn.textContent = addCompareBtn.disabled ? 'In comparison' : '+ Add to comparison';
  }
  document.getElementById('built')!.hidden = !built;
  for (const b of sizeButtons) b.classList.toggle('on', b.dataset.size === size);

  compareBar.hidden = comparison.length === 0;
  compareChips.replaceChildren(...comparison.map((sp) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `chip${built?.name === sp.name ? ' on' : ''}`;
    chip.title = `Show ${sp.name}`;

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = sp.capColor ?? '#555';

    const label = document.createElement('i');
    label.textContent = sp.name;

    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '\u00d7';
    x.title = `Remove ${sp.name}`;
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      comparison.splice(comparison.indexOf(sp), 1);
      renderWorkbench();
    });

    chip.append(dot, label, x);
    chip.addEventListener('click', () => build(sp));
    return chip;
  }));
}

releaseBuilt = () => {
  if (!built) return; // cheap no-op on the drag hot path
  built = null;
  renderWorkbench();
};

function addToComparison(sp: Species) {
  if (!comparison.some((s) => s.name === sp.name)) comparison.push(sp);
  renderWorkbench();
}

for (const b of sizeButtons) {
  b.addEventListener('click', () => {
    if (built) build(built, b.dataset.size as SizeVariant);
  });
}
addCompareBtn.addEventListener('click', () => { if (built) addToComparison(built); });
document.getElementById('clearcompare')!.addEventListener('click', () => {
  comparison.length = 0;
  renderWorkbench();
});

{
  const input = document.getElementById('search') as HTMLInputElement;
  const list = document.getElementById('results') as HTMLUListElement;
  let hits: Species[] = [];
  let sel = -1;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    sel = -1;
  };

  const choose = (sp: Species) => {
    chooseSpecies(sp);
    close();
  };

  const draw = () => {
    list.replaceChildren();
    if (!hits.length) {
      const li = document.createElement('li');
      li.className = 'none';
      li.textContent = 'no species matches that name';
      list.appendChild(li);
    } else {
      hits.forEach((sp, i) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.className = i === sel ? 'sel' : '';

        const meta = document.createElement('span');
        meta.className = 'meta';
        const em = document.createElement('em');
        em.textContent = sp.name;
        const tag = document.createElement('small');
        const common = matchedCommonName(input.value, sp);
        tag.textContent = [common, sp.hymenium, sp.edibility[0]].filter(Boolean).join(' \u00b7 ');
        meta.append(em, tag);

        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'add';
        add.textContent = comparison.some((s) => s.name === sp.name) ? 'added' : '+ compare';
        add.title = 'Add to comparison';
        add.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          addToComparison(sp);
          add.textContent = 'added';
        });

        li.append(meta, add);
        li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(sp); });
        list.appendChild(li);
      });
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  input.addEventListener('input', () => {
    hits = search(input.value, species, 8);
    sel = hits.length ? 0 : -1;
    if (input.value.trim()) draw(); else close();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return close();
    if (!hits.length || list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length;
      draw();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(hits[Math.max(0, sel)]);
    }
  });

  // Only species that record a size and a colour: one built from defaults
  // would look like the starting mushroom and read as "nothing happened".
  document.getElementById('surprise')!.addEventListener('click', () => {
    const pool = species.filter((sp) => sp.capCm && sp.capColor && sp !== built);
    if (!pool.length) return;
    choose(pool[Math.floor(Math.random() * pool.length)]);
  });

  input.addEventListener('blur', () => setTimeout(close, 140));
  input.addEventListener('focus', () => { if (input.value.trim() && hits.length) draw(); });
}

// ---------------------------------------------------------------- photo slideshow

/**
 * Click a match photo to open a slideshow of that species' pictures.
 *
 * The photos live in their own JSON, fetched on first open rather than bundled:
 * roughly 690 KB most visitors never look at. It is served from public/ and
 * resolved against document.baseURI, so it works from a project path, a user
 * site or a custom domain. (A dynamically imported JSON module is not emitted
 * as an asset by Vite, which 404'd in production while working in dev.)
 *
 * Galleries are filtered at build time to images that actually name the species
 * -- Amanita muscaria's article also carries a 4th-century mosaic and a photo of
 * Amanita crocea, and showing a different mushroom would be worse than none.
 */
type Shot = { url: string; artist: string; license: string; page: string };
let gallery: Record<string, Shot[]> | null = null;
let shots: Shot[] = [];
let shotIndex = 0;

const lb = document.getElementById('lightbox')!;
const lbImg = document.getElementById('lb-img') as HTMLImageElement;
const lbTitle = document.getElementById('lb-title')!;
const lbCount = document.getElementById('lb-count')!;
const lbCredit = document.getElementById('lb-credit')!;
const lbPrev = document.getElementById('lb-prev') as HTMLButtonElement;
const lbNext = document.getElementById('lb-next') as HTMLButtonElement;
let lastFocus: HTMLElement | null = null;

function showShot(i: number) {
  if (!shots.length) return;
  shotIndex = (i + shots.length) % shots.length;
  const shot = shots[shotIndex];
  const url = safeUrl(shot.url);
  if (url) setPhoto(lbImg, url, 1280); else lbImg.removeAttribute('src');
  lbCount.textContent = `photo ${shotIndex + 1} of ${shots.length}`;
  // full attribution: author, licence, and a link to the source file page
  const source = safeUrl(shot.page);
  const credit = `${shot.artist} \u00b7 ${shot.license} \u00b7 `;
  lbCredit.replaceChildren(
    document.createTextNode(credit),
    source
      ? Object.assign(document.createElement('a'), {
          href: source, target: '_blank', rel: 'noopener noreferrer',
          textContent: 'source on Wikimedia Commons',
        })
      : document.createTextNode('Wikimedia Commons'),
  );
  const only = shots.length < 2;
  lbPrev.disabled = only;
  lbNext.disabled = only;
  // preload the neighbour so stepping through feels instant
  if (!only) {
    const next = safeUrl(shots[(shotIndex + 1) % shots.length].url);
    if (next) new Image().src = wikiThumb(next, 1280);
  }
}

async function openGallery(sp: Species, trigger: HTMLElement) {
  if (!gallery) {
    lbTitle.textContent = 'loading\u2026';
    try {
      const res = await fetch(new URL('gallery.json', document.baseURI));
      if (!res.ok) throw new Error(`gallery.json: ${res.status}`);
      gallery = (await res.json()) as Record<string, Shot[]>;
    } catch (err) {
      // fall back to the single photo already on the card rather than hanging
      console.error('could not load the photo gallery', err);
      gallery = {};
    }
  }
  shots = gallery[sp.name] ?? (sp.image ? [sp.image] : []);
  if (!shots.length) return;
  lastFocus = trigger;
  lbTitle.textContent = sp.name;
  lbImg.alt = sp.name;
  showShot(0);
  lb.hidden = false;
  lbNext.focus();
}

function closeGallery() {
  lb.hidden = true;
  lbImg.removeAttribute('src');
  lastFocus?.focus();
}

lbPrev.addEventListener('click', () => showShot(shotIndex - 1));
lbNext.addEventListener('click', () => showShot(shotIndex + 1));
document.getElementById('lb-close')!.addEventListener('click', closeGallery);
lb.addEventListener('click', (e) => { if (e.target === lb) closeGallery(); });
addEventListener('keydown', (e) => {
  if (lb.hidden) return;
  if (e.key === 'Escape') closeGallery();
  else if (e.key === 'ArrowLeft') showShot(shotIndex - 1);
  else if (e.key === 'ArrowRight') showShot(shotIndex + 1);
});

// ---------------------------------------------------------------- frame loop

let framed = false;
function fitCamera(totalHeight: number, capR: number) {
  const extent = Math.max(totalHeight, capR * 2, 1.5);
  // Fit both axes rather than guessing a factor: a wide cap in a narrow column
  // overflows sideways long before it overflows vertically.
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const MARGIN = 1.45; // breathing room around the mushroom
  const want = Math.max(
    (totalHeight / 2) / Math.tan(vFov / 2),
    capR / Math.tan(hFov / 2),
  ) * MARGIN + 1.5;
  const target = new THREE.Vector3(0, totalHeight * 0.45, 0);
  // snap on the first frame, then ease: otherwise the opening view is mid-lerp
  // and a tall mushroom loads with its cap cropped off the top
  controls.target.lerp(target, framed ? 0.12 : 1);
  const dir = camera.position.clone().sub(controls.target);
  const d = dir.length();
  // slow ease afterwards, so a drag shows the real size change before settling
  const next = framed ? d + (want - d) * 0.07 : want;
  framed = true;
  camera.position.copy(controls.target).add(dir.setLength(next));
  // keep the fade relative to the viewing distance, not absolute
  const fog = scene.fog as THREE.Fog;
  fog.near = next * 0.9;
  fog.far = next * 3.4;
  grid.scale.setScalar(Math.max(1, extent / 12));
}

function resize() {
  const w = canvasWrap.clientWidth;
  const h = canvasWrap.clientHeight;
  // updateStyle must stay on: without a CSS size the canvas falls back to its
  // attribute size, which setPixelRatio has already multiplied by the display
  // scale -- on a 2x screen that renders the canvas at double width, spilling it
  // underneath the side panels. Invisible at dpr 1, broken on every Retina display.
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvasWrap);
resize();

let lastHash = 0;
function frame() {
  if (dirty) {
    dirty = false;
    mushroom.update(params);
    /**
     * When a species was explicitly built, tell the matcher two things: which
     * traits that species never recorded (so no competitor is credited for
     * matching a value that came from the defaults), and which species the user
     * actually asked for (so it wins ties against equally-good matches).
     * Editing the shape by hand clears `built`, and the values become real
     * choices again.
     */
    renderMatches(rank(params, species, MATCH_COUNT,
      built ? { skip: unknownTraits(built), prefer: built.name } : {}));
    hashPending = true;
  }
  if (hashPending && performance.now() - lastHash > 400) {
    hashPending = false;
    lastHash = performance.now();
    writeHash();
  }
  const pr = mushroom.profile;
  fitCamera(pr.totalHeight, pr.capR);
  layoutHandles();
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

/** Load the dataset, then resolve any species named in the URL. */
import('./data/species.json').then((m) => {
  species = m.default as unknown as Species[];
  for (const id of ['search', 'surprise']) {
    (document.getElementById(id) as HTMLInputElement | HTMLButtonElement).disabled = false;
  }
  dirty = true; // re-rank now that there is something to rank against
  const byName = (n: string) => species.find((s) => s.name === n || s.page === n);
  for (const n of pendingCompare) {
    const sp = byName(n);
    if (sp) addToComparison(sp);
  }
  if (pendingBuilt) {
    const sp = byName(pendingBuilt);
    // build() overwrites the shape; only do it when the URL did not also carry one
    if (sp) build(sp, pendingSize);
  } else {
    renderWorkbench();
  }
}).catch((err) => {
  console.error('could not load the species data', err);
  setStatus('could not load the species data \u2014 reload to retry');
});

syncInputs();
frame();
