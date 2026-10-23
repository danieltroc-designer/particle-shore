import { SCENES, SCENE_MAP, sceneDefaults } from './scenes.js';

export const RESOLUTIONS = [
  { id: '3840x2160', label: '4K UHD · 3840 × 2160', short: '4K', w: 3840, h: 2160 },
  { id: '4096x2160', label: 'DCI 4K · 4096 × 2160', short: 'DCI 4K', w: 4096, h: 2160 },
  { id: '5120x2880', label: '5K · 5120 × 2880', short: '5K', w: 5120, h: 2880 },
  { id: '7680x4320', label: '8K · 7680 × 4320', short: '8K', w: 7680, h: 4320 },
  { id: '1920x1080', label: 'HD · 1920 × 1080', short: 'HD', w: 1920, h: 1080 },
  { id: '2480x520', label: 'SoundCloud banner · 2480 × 520', short: 'SoundCloud', w: 2480, h: 520, guide: 'soundcloud' },
  { id: 'custom', label: 'Custom size', short: 'Custom', custom: true },
];

// Custom sizes: each side 16–16384 px, at most 64 megapixels (8K is 33).
export const CUSTOM_LIMITS = { min: 16, max: 16384, maxPixels: 64e6 };

export function clampCustom(w, h) {
  const { min, max, maxPixels } = CUSTOM_LIMITS;
  w = Math.round(Math.min(max, Math.max(min, +w || min)));
  h = Math.round(Math.min(max, Math.max(min, +h || min)));
  if (w * h > maxPixels) {
    const k = Math.sqrt(maxPixels / (w * h));
    w = Math.max(min, Math.floor(w * k));
    h = Math.max(min, Math.floor(h * k));
  }
  return { w, h };
}

// The output size of a state, with custom dimensions filled in.
export function resolutionOf(state) {
  const r = RESOLUTIONS.find((x) => x.id === state.output) || RESOLUTIONS[0];
  if (!r.custom) return r;
  const { w, h } = clampCustom(state.custom.w, state.custom.h);
  return { ...r, w, h, label: `Custom · ${w} × ${h}` };
}

// Sizes and distances are in 4K pixels; other resolutions scale them.
export const LOOK = {
  particles: [
    { key: 'density', label: 'Density', min: 0.1, max: 8, step: 0.01, def: 1.4, hint: 'Candidate particles per 4K pixel' },
    { key: 'size', label: 'Size', min: 0.4, max: 8, step: 0.01, def: 1.5, unit: 'px' },
    { key: 'sizeVar', label: 'Size variation', min: 0, max: 1, step: 0.01, def: 0.45 },
    { key: 'intensity', label: 'Intensity', min: 0.02, max: 2, step: 0.01, def: 0.7 },
    { key: 'intensityVar', label: 'Sparkle', min: 0, max: 1, step: 0.01, def: 0.7, hint: 'Random brightness per particle' },
    { key: 'softness', label: 'Softness', min: 0, max: 1, step: 0.01, def: 0.3, hint: 'Edge softness of larger dots' },
    { key: 'scatter', label: 'Scatter', min: 0, max: 40, step: 0.1, def: 0, unit: 'px', hint: 'Random jitter of each particle' },
    { key: 'drift', label: 'Drift', min: 0, max: 120, step: 0.5, def: 0, unit: 'px', hint: 'Displace particles along a noise flow' },
    { key: 'driftScale', label: 'Drift scale', min: 0.5, max: 24, step: 0.1, def: 4 },
  ],
  tone: [
    { key: 'gain', label: 'Light', min: 0, max: 4, step: 0.01, def: 1, hint: 'Multiplies the shape light before tone' },
    { key: 'black', label: 'Black point', min: 0, max: 0.9, step: 0.005, def: 0 },
    { key: 'contrast', label: 'Contrast', min: 0.3, max: 4, step: 0.01, def: 1.5 },
    { key: 'exposure', label: 'Exposure', min: 0.1, max: 4, step: 0.01, def: 1.6 },
    { key: 'dust', label: 'Dust', min: 0, max: 0.03, step: 0.0005, def: 0.0015, hint: 'Sparse particles everywhere' },
    { key: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.01, def: 0.2 },
  ],
  comp: [
    { key: 'x', label: 'Offset X', min: -3, max: 3, step: 0.001, def: 0 },
    { key: 'y', label: 'Offset Y', min: -3, max: 3, step: 0.001, def: 0 },
    { key: 'zoom', label: 'Zoom', min: 0.2, max: 6, step: 0.001, def: 1 },
    { key: 'rotate', label: 'Rotate', min: -180, max: 180, step: 0.1, def: 0, unit: '°' },
  ],
  svg: [
    { key: 'budget', label: 'Particles', min: 10000, max: 1000000, step: 5000, def: 150000 },
    { key: 'dotScale', label: 'Dot scale', min: 0.25, max: 4, step: 0.01, def: 1, hint: 'Relative to the size that matches the raster brightness' },
  ],
};

const defaults = (list) => Object.fromEntries(list.map((p) => [p.key, p.def]));

export function defaultState() {
  return {
    app: 'particle-shore',
    v: 1,
    scene: 'dunes',
    seed: 1207,
    shapes: Object.fromEntries(SCENES.map((s) => [s.id, sceneDefaults(s)])),
    particles: defaults(LOOK.particles),
    tone: { ...defaults(LOOK.tone), invert: false },
    color: { bg: '#000000', ink: '#f3f1ec', inkShadow: '#f3f1ec', transparent: false },
    comp: defaults(LOOK.comp),
    output: '3840x2160',
    custom: { w: 2400, h: 2400 },
    svg: { ...defaults(LOOK.svg), opacity: 'varied', geometry: 'circles' },
  };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Copies only keys the base already has, with matching types.
export function merge(base, over) {
  if (!isObj(over)) return base;
  for (const k of Object.keys(over)) {
    if (!(k in base)) continue;
    if (isObj(base[k])) merge(base[k], over[k]);
    else if (typeof base[k] === typeof over[k] && (typeof over[k] !== 'number' || Number.isFinite(over[k]))) base[k] = over[k];
  }
  return base;
}

export function normalizeState(s) {
  const st = merge(defaultState(), s);
  if (!SCENE_MAP[st.scene]) st.scene = 'dunes';
  if (!RESOLUTIONS.some((r) => r.id === st.output)) st.output = RESOLUTIONS[0].id;
  st.custom = clampCustom(st.custom.w, st.custom.h);
  return st;
}

export const PRESETS = [
  {
    name: 'Dune crest',
    scene: 'dunes',
    seed: 1207,
    shape: {},
  },
  {
    name: 'Doorway',
    scene: 'beam',
    seed: 41,
    shape: {},
    particles: { density: 2.6, size: 1, intensity: 0.42, intensityVar: 0.55 },
    tone: { contrast: 1.15, exposure: 1.25, vignette: 0.1, dust: 0.003 },
  },
  {
    name: 'Eclipse',
    scene: 'halo',
    seed: 7,
    shape: {},
    tone: { vignette: 0.1 },
  },
  {
    name: 'Moon',
    scene: 'orb',
    seed: 3,
    shape: {},
    tone: { contrast: 1.4 },
  },
  {
    name: 'Silk',
    scene: 'silk',
    seed: 12,
    shape: {},
    tone: { contrast: 1.6, vignette: 0.35 },
  },
  {
    name: 'Smoke',
    scene: 'nebula',
    seed: 90,
    shape: {},
    particles: { drift: 14, driftScale: 3 },
    tone: { contrast: 1.4 },
  },
  {
    name: 'Night swell',
    scene: 'dunes',
    seed: 55,
    shape: { sharp: 0.15, asym: 0.3, scale: 14, amp: 2, wind: 10, sunAz: 150, sunEl: 10, focus: 1.2, sunI: 2.2, sheen: 1.5, horizon: 0.25, camH: 2, pitch: -5, yaw: 0, fog: 1 },
    particles: { size: 1.2, intensityVar: 0.8 },
  },
  {
    name: 'Graphite',
    scene: 'silk',
    seed: 31,
    shape: {},
    particles: { size: 1.7, intensity: 0.8, sizeVar: 0.4 },
    tone: { invert: true, contrast: 1.2, exposure: 1.05, vignette: 0 },
    color: { bg: '#ece8e1', ink: '#141414', inkShadow: '#141414' },
  },
  {
    name: 'Ember beam',
    scene: 'beam',
    seed: 77,
    shape: { spread: 6, width: 0.4, angle: -14, cutX: 2.4, slabI: 0, haze: 0.4 },
    tone: { contrast: 1.1 },
    color: { ink: '#ffe2b0', inkShadow: '#b5532a' },
  },
];

export function applyPreset(current, preset) {
  const s = defaultState();
  s.shapes = structuredClone(current.shapes);
  s.shapes[preset.scene] = merge(sceneDefaults(SCENE_MAP[preset.scene]), preset.shape);
  s.scene = preset.scene;
  s.seed = preset.seed ?? s.seed;
  for (const k of ['particles', 'tone', 'color', 'comp']) merge(s[k], preset[k]);
  s.output = current.output;
  s.custom = { ...current.custom };
  s.svg = structuredClone(current.svg);
  return s;
}
