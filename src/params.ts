/**
 * The single source of truth for the mushroom: one flat object that drives both
 * the 3D mesh and the species matcher. Nothing else holds shape state.
 */

export type Hymenium = 'gills' | 'pores' | 'teeth' | 'ridges' | 'smooth' | 'gleba';
export type GillAttachment = 'free' | 'adnexed' | 'adnate' | 'sinuate' | 'decurrent';
export type Ecology = 'mycorrhizal' | 'saprotrophic' | 'parasitic';

export type MushroomParams = {
  capDiameter: number; // cm -- species data is diameter, so store diameter
  capHeight: number; // cm, vertical extent of the cap dome
  capCurve: number; // -1 funnel .. 0 flat .. +1 conical
  stemHeight: number; // cm
  stemWidth: number; // cm, diameter
  capColor: string; // hex
  stemColor: string; // hex
  hymenium: Hymenium;
  gillAttachment: GillAttachment;
  warts: number; // 0..1 density
  scales: number; // 0..1 density
  ring: boolean;
  volva: boolean;
  /**
   * Invisible on the model but recorded for most species, and the strongest
   * remaining discriminator once shape and colour agree. null means "I don't
   * know", which is the honest default -- a beginner has not taken a spore
   * print -- and is not scored at all.
   */
  sporePrint: string | null;
  ecology: Ecology | null;
};

/** A generic brown convex gilled mushroom -- the "base mushroom" you start from. */
export const DEFAULTS: MushroomParams = {
  capDiameter: 8,
  capHeight: 3,
  capCurve: 0.45,
  stemHeight: 7,
  stemWidth: 1.2,
  capColor: '#a9733f',
  stemColor: '#e8dcc4',
  hymenium: 'gills',
  gillAttachment: 'adnate',
  warts: 0,
  scales: 0,
  ring: false,
  volva: false,
  sporePrint: null,
  ecology: null,
};

/**
 * Ranges wide enough to hold every species in the dataset. Phlebopus marginatus
 * has a recorded 80 cm cap and Boletus pinophilus a 16 cm stem diameter; clamping
 * below those meant such species could not match their own recorded size.
 */
export const LIMITS = {
  capDiameter: [0.5, 100],
  capHeight: [0.2, 30],
  capCurve: [-1, 1],
  stemHeight: [0, 50],
  stemWidth: [0.1, 18],
  warts: [0, 1],
  scales: [0, 1],
} as const satisfies Record<string, readonly [number, number]>;

export type NumericKey = keyof typeof LIMITS;

export const clamp = (k: NumericKey, v: number) =>
  Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], v));

export const HYMENIA: { value: Hymenium; label: string; hint: string }[] = [
  { value: 'gills', label: 'Gills', hint: 'blades under the cap' },
  { value: 'pores', label: 'Pores', hint: 'sponge-like tubes (boletes)' },
  { value: 'teeth', label: 'Teeth', hint: 'hanging spines' },
  { value: 'ridges', label: 'Ridges', hint: 'blunt folds (chanterelles)' },
  { value: 'smooth', label: 'Smooth', hint: 'no structure' },
  { value: 'gleba', label: 'Gleba', hint: 'spores inside (puffballs, truffles)' },
];

export const ATTACHMENTS: GillAttachment[] = ['free', 'adnexed', 'adnate', 'sinuate', 'decurrent'];

/** The Mycomorphbox spore-print vocabulary, ordered light to dark. */
export const SPORE_PRINTS = [
  'white', 'cream', 'buff', 'tan', 'ochre', 'yellow', 'yellow-orange', 'yellow-brown',
  'salmon', 'pink', 'pinkish-brown', 'reddish-brown', 'brown', 'olive', 'olive-brown',
  'green', 'purple', 'purple-brown', 'purple-black', 'blackish-brown', 'black',
];

export const ECOLOGIES: { value: Ecology; hint: string }[] = [
  { value: 'mycorrhizal', hint: 'partnered with tree roots' },
  { value: 'saprotrophic', hint: 'feeds on dead matter' },
  { value: 'parasitic', hint: 'feeds on a living host' },
];

/**
 * Cap and stem colours, drawn from the colours real species in the dataset
 * actually have -- a free colour wheel invites hot pink and cyan, which no
 * mushroom is, and which can therefore never match anything.
 *
 * The olives, violets and indigos are NOT decorative: Amanita phalloides (the
 * death cap) is pale olive-green, Cortinarius violaceus is deep violet, and
 * Entoloma hochstetteri is indigo. Dropping those hues would make real species
 * unreachable. There is no green or blue here that some species does not have.
 */
export type Swatch = { hex: string; name: string };
export const PALETTE: Swatch[] = [
  // whites, creams and buffs
  { hex: '#f5f1e8', name: 'pure white' },
  { hex: '#f0e9db', name: 'white' },
  { hex: '#ece4d2', name: 'off-white' },
  { hex: '#e4ded2', name: 'greyish white' },
  { hex: '#ddd8c6', name: 'buff' },
  { hex: '#cbbb94', name: 'pale cream' },
  { hex: '#d8bf96', name: 'pale tan' },
  { hex: '#b9a994', name: 'pale grey-brown' },
  // yellows and ochres
  { hex: '#e8cf3e', name: 'sulphur yellow' },
  { hex: '#d8c23a', name: 'yellowish' },
  { hex: '#e8b02a', name: 'golden yellow' },
  { hex: '#e8a81e', name: 'deep yellow' },
  { hex: '#e8a93c', name: 'golden' },
  { hex: '#c9a86a', name: 'yellow-brown' },
  // oranges
  { hex: '#e0a040', name: 'orange-tan' },
  { hex: '#e08a1e', name: 'golden orange' },
  { hex: '#e8751a', name: 'orange' },
  { hex: '#e2752a', name: 'carrot orange' },
  { hex: '#d4701e', name: 'dull orange' },
  { hex: '#e35b22', name: 'orange-red' },
  // browns -- the great majority of mushrooms
  { hex: '#c0a068', name: 'tan' },
  { hex: '#b58b4a', name: 'ochraceous tawny' },
  { hex: '#b8842a', name: 'tawny' },
  { hex: '#a9743f', name: 'caramel' },
  { hex: '#9a7240', name: 'ochre brown' },
  { hex: '#8a5a2b', name: 'brown' },
  { hex: '#7a4a28', name: 'chestnut' },
  { hex: '#6b3f24', name: 'dark brown' },
  { hex: '#6b3a28', name: 'reddish brown' },
  { hex: '#4a3225', name: 'bistre' },
  // reds
  { hex: '#d8291c', name: 'bright red' },
  { hex: '#d81f2a', name: 'scarlet' },
  { hex: '#cf1f24', name: 'deep red' },
  { hex: '#a34a3c', name: 'reddish' },
  { hex: '#8a3a2a', name: 'reddish-brown' },
  { hex: '#8a5d4e', name: 'tan-brown' },
  { hex: '#a0201e', name: 'crimson' },
  // pinks: Gomphidius roseus, Phlebia incarnata and Amanita ravenelii are pink
  { hex: '#d8a0a0', name: 'pink' },
  { hex: '#d88a92', name: 'rose' },
  { hex: '#e0bfae', name: 'flesh' },
  // greys and blacks
  { hex: '#9c9389', name: 'grey-brown' },
  { hex: '#8f8578', name: 'greyish' },
  { hex: '#8a7a68', name: 'light grey-brown' },
  { hex: '#6b5e52', name: 'dark grey-brown' },
  { hex: '#4a4542', name: 'slate' },
  { hex: '#2f2d2b', name: 'near-black' },
  { hex: '#2b2320', name: 'black-brown' },
  // the genuine outliers, each justified by a real species
  { hex: '#9a6a9e', name: 'light violet' },
  { hex: '#6b3b2b', name: 'purple-brown' },
  { hex: '#4a2a6e', name: 'deep violet' },
  { hex: '#9fae63', name: 'pale olive-green' },
  { hex: '#6b6b3a', name: 'greenish-brown' },
  { hex: '#4f5a2e', name: 'dark olive' },
  // Russula virescens is the green russula; Cortinarius austrovenetus is green too
  { hex: '#4a7a3a', name: 'green' },
  { hex: '#3a56a0', name: 'indigo' },
  { hex: '#2a6ba8', name: 'indigo-blue' },
  { hex: '#8f9ab9', name: 'grey-blue' },
  { hex: '#3a2842', name: 'violet-black' },
];

/**
 * Mycomorphbox capShape values placed on one domed..sunken axis, so a continuous
 * drag of capCurve can be scored against the discrete vocabulary.
 * "offset" (lateral stem, e.g. oyster mushrooms) is not on this axis and is
 * deliberately absent -- the matcher skips the trait rather than inventing a position.
 */
export const SHAPE_AXIS: Record<string, number> = {
  conical: 1.0,
  ovate: 0.85,
  campanulate: 0.7,
  convex: 0.45,
  umbonate: 0.25,
  flat: 0,
  depressed: -0.45,
  umbilicate: -0.6,
  infundibuliform: -1.0,
};

/** Nearest vocabulary term for a curve value -- used for the UI readout. */
export function shapeName(curve: number): string {
  let best = 'flat';
  let d = Infinity;
  for (const [name, v] of Object.entries(SHAPE_AXIS)) {
    const dist = Math.abs(v - curve);
    if (dist < d) { d = dist; best = name; }
  }
  return best;
}
