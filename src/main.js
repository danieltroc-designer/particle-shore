import { Renderer, hexToRgb, frameK, refScale } from './renderer.js';
import { SCENES, SCENE_MAP, sceneDefaults } from './scenes.js';
import { LOOK, RESOLUTIONS, PRESETS, CUSTOM_LIMITS, defaultState, normalizeState, applyPreset, clampCustom, resolutionOf } from './params.js';
import { h, section, subhead, slider, colorRow, toggleRow, selectRow } from './ui.js';
import { encodePNG, readPNGText } from './png.js';
import { buildSVG, readSVGMeta } from './svg.js';
import { listDesigns, putDesign, deleteDesign, newId } from './library.js';

const STORE_KEY = 'particle-shore:state:v1';
const $ = (sel) => document.querySelector(sel);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// Yields to the browser; the timer keeps exports going in background tabs,
// where requestAnimationFrame is paused.
const nextFrame = () => new Promise((r) => {
  let done = false;
  const go = () => !done && (done = true, r());
  requestAnimationFrame(go);
  setTimeout(go, 50);
});

const canvas = $('#view');
const stage = $('#stage');
const panel = $('#panel');

function loadSaved() {
  try {
    const s = localStorage.getItem(STORE_KEY);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

let state = normalizeState(loadSaved());
let renderer;
try {
  renderer = new Renderer(canvas);
} catch (e) {
  fatal(e.message);
  throw e;
}

const view = { mode: 'fit', cx: 0.5, cy: 0.5 };
const perf = { field: 0, particles: 0 };
const controls = new Map();
let busy = false;

// ---------- history & persistence ----------

const history = { past: [], future: [], last: JSON.stringify(state) };
let saveTimer = 0;

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch {}
  }, 250);
}

function commit() {
  const s = JSON.stringify(state);
  if (s === history.last) return;
  history.past.push(history.last);
  if (history.past.length > 200) history.past.shift();
  history.future = [];
  history.last = s;
  persist();
}

let commitTimer = 0;
const commitSoon = () => {
  clearTimeout(commitTimer);
  commitTimer = setTimeout(commit, 400);
};

function restore(json) {
  state = normalizeState(JSON.parse(json));
  history.last = json;
  buildPanel();
  layout();
  requestRender('shape');
  persist();
}

function undo() {
  commit();
  if (!history.past.length) return;
  history.future.push(history.last);
  restore(history.past.pop());
}

function redo() {
  if (!history.future.length) return;
  history.past.push(history.last);
  restore(history.future.pop());
}

function replaceState(next, message) {
  state = normalizeState(next);
  buildPanel();
  layout();
  requestRender('shape');
  commit();
  if (message) toast(message);
}

// ---------- rendering ----------

function resolution() {
  return resolutionOf(state);
}

function viewSpec(quality) {
  const { w: W, h: H } = resolution();
  const exportScale = refScale(W, H);
  if (view.mode === 'actual') {
    const rw = Math.min(canvas.width, W), rh = Math.min(canvas.height, H);
    let rx = Math.round(view.cx * W - rw / 2), ry = Math.round(view.cy * H - rh / 2);
    rx = clamp(rx, 0, W - rw);
    ry = clamp(ry, 0, H - rh);
    return { vOut: [W, H], region: [rx, ry, rw, rh], vScale: exportScale, fieldTexel: Math.max(1, Math.round(2 * exportScale)) };
  }
  // preview at most at 4K-equivalent; drafts at roughly canvas resolution
  let scale = Math.min(exportScale, 1);
  if (quality === 'draft') scale = Math.min(scale, Math.max(0.3, (canvas.height / H) * exportScale * 0.75));
  const vH = Math.round((H * scale) / exportScale), vW = Math.round((W * scale) / exportScale);
  const vScale = (exportScale * vH) / H;
  const fieldTexel = Math.max(1, 2 * vScale) * (quality === 'draft' ? 1.6 : 1);
  return { vOut: [vW, vH], region: [0, 0, vW, vH], vScale, fieldTexel };
}

let rafId = 0;
let wanted = null;
let idleTimer = 0;

// kind: 'shape' (field + particles), 'look' (particles only), 'view'
function requestRender(kind = 'look', interactive = false) {
  if (kind === 'none') return;
  const predicted = kind === 'look' ? perf.particles : perf.field + perf.particles;
  const q = interactive && view.mode === 'fit' && predicted > 50 ? 'draft' : 'full';
  if (wanted !== 'full') wanted = q;
  if (!rafId) rafId = requestAnimationFrame(renderNow);
  clearTimeout(idleTimer);
  if (q === 'draft') idleTimer = setTimeout(() => requestRender(kind, false), 220);
}

function renderNow() {
  rafId = 0;
  const q = wanted || 'full';
  wanted = null;
  const spec = viewSpec(q);
  try {
    const t = renderer.renderView(state, spec);
    if (q === 'full') {
      if (t.fieldMs != null) perf.field = t.fieldMs;
      perf.particles = t.particleMs;
    }
    updateStatus(spec, t, q);
  } catch (e) {
    console.error(e);
    toast(e.message, true);
  }
}

function layout() {
  const { w: W, h: H } = resolution();
  const r = stage.getBoundingClientRect();
  const pad = r.width < 600 ? 12 : 32;
  const aw = Math.max(40, r.width - pad * 2), ah = Math.max(40, r.height - pad * 2);
  let cw = aw, ch = (aw * H) / W;
  if (ch > ah) {
    ch = ah;
    cw = (ah * W) / H;
  }
  cw = Math.floor(cw);
  ch = Math.floor(ch);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  const bw = Math.round(cw * dpr), bh = Math.round(ch * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
    return true;
  }
  return false;
}

new ResizeObserver(() => {
  if (layout()) {
    cancelAnimationFrame(rafId);
    rafId = 0;
    wanted = 'full';
    renderNow();
  }
}).observe(stage);

const fmtCount = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));

function updateStatus(spec, t, q) {
  const res = resolution();
  const scene = SCENE_MAP[state.scene];
  $('#st-left').textContent = `${scene.name} · seed ${state.seed} · ${res.w} × ${res.h}`;
  const zoom = view.mode === 'actual' ? '100%' : Math.round((canvas.width / res.w) * 100) + '%';
  const ms = (t.fieldMs ?? 0) + t.particleMs;
  $('#st-right').textContent = `${fmtCount(t.candidates)} candidates · ${ms.toFixed(0)} ms${q === 'draft' ? ' · draft' : ''} · ${zoom}`;
  $('#hint').textContent = view.mode === 'actual'
    ? 'Actual pixels — drag to pan · double-click to fit'
    : 'Drag to move · pinch to zoom · double-click to inspect at 100%';
}

function setView(mode) {
  view.mode = mode;
  document.querySelectorAll('#viewseg button').forEach((b) => b.classList.toggle('on', b.dataset.view === mode));
  canvas.classList.toggle('actual', mode === 'actual');
  requestRender('view');
}

// ---------- panel ----------

function bindSlider(def, obj, kind, path) {
  const row = slider(def, obj[def.key], {
    onInput: (v, interactive) => {
      obj[def.key] = v;
      requestRender(kind, interactive);
      if (!interactive) persist();
    },
    onCommit: commit,
  });
  if (path) controls.set(path, row);
  return row;
}

function bindColor(label, key) {
  return colorRow(label, state.color[key], {
    onInput: (v) => {
      state.color[key] = v;
      requestRender('look');
    },
    onCommit: commit,
  });
}

function iconSvg(inner) {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

function buildPanel() {
  controls.clear();
  panel.replaceChildren();

  // Shape picker
  const shape = section(panel, 'Shape', 'shape');
  shape.body.append(
    h('div', { class: 'scene-grid' }, SCENES.map((sc) => h('button', {
      class: 'scene-btn' + (sc.id === state.scene ? ' on' : ''),
      title: sc.blurb,
      onclick: () => {
        if (sc.id === state.scene) return;
        state.scene = sc.id;
        buildPanel();
        requestRender('shape');
        commit();
      },
    }, h('span', { class: 'glyph', html: iconSvg(sc.icon) }), h('span', null, sc.name)))),
    h('div', { class: 'label-sm' }, 'Presets'),
    h('div', { class: 'chips' }, PRESETS.map((p) => h('button', { class: 'chip', onclick: () => replaceState(applyPreset(state, p), `Preset · ${p.name}`) }, p.name))),
  );
  const seedInput = h('input', { type: 'text', class: 'num seed', inputmode: 'numeric', value: String(state.seed), 'aria-label': 'Seed' });
  seedInput.addEventListener('change', () => {
    const v = Math.abs(parseInt(seedInput.value, 10));
    if (Number.isFinite(v)) {
      state.seed = v % 1000000;
      requestRender('shape');
      commit();
    }
    seedInput.value = String(state.seed);
  });
  seedInput.addEventListener('focus', () => seedInput.select());
  shape.body.append(h('div', { class: 'row seedrow' },
    h('label', null, 'Seed'),
    seedInput,
    h('button', { class: 'mini', onclick: newSeed, title: 'New seed (S)' }, 'New'),
    h('button', { class: 'mini', onclick: randomize, title: 'Randomize shape (R)' }, 'Randomize'),
  ));
  controls.set('seed', { update: (v) => (seedInput.value = String(v)) });

  // Scene parameters
  const scene = SCENE_MAP[state.scene];
  const resetBtn = h('button', {
    class: 'mini ghost',
    title: 'Reset this shape to its defaults',
    onclick: () => {
      state.shapes[state.scene] = sceneDefaults(scene);
      buildPanel();
      requestRender('shape');
      commit();
    },
  }, 'Reset');
  const sp = section(panel, scene.name, 'scene', { actions: resetBtn });
  let group = null;
  for (const p of scene.params) {
    if (p.group !== group) {
      group = p.group;
      sp.body.append(subhead(group));
    }
    sp.body.append(bindSlider(p, state.shapes[state.scene], 'shape'));
  }

  // Particles & tone
  const parts = section(panel, 'Particles', 'particles');
  for (const def of LOOK.particles) parts.body.append(bindSlider(def, state.particles, 'look'));
  const tone = section(panel, 'Tone', 'tone');
  for (const def of LOOK.tone) tone.body.append(bindSlider(def, state.tone, 'look'));
  tone.body.append(toggleRow('Ink follows shadows', state.tone.invert, (v) => {
    state.tone.invert = v;
    requestRender('look');
    commit();
  }));

  // Color
  const color = section(panel, 'Color', 'color');
  color.body.append(
    bindColor('Background', 'bg'),
    bindColor('Ink · lights', 'ink'),
    bindColor('Ink · shadows', 'inkShadow'),
    toggleRow('Transparent background', state.color.transparent, (v) => {
      state.color.transparent = v;
      requestRender('look');
      commit();
    }),
    h('div', { class: 'row buttons' },
      h('button', {
        class: 'mini',
        onclick: () => {
          const c = state.color;
          [c.bg, c.ink] = [c.ink, c.bg];
          c.inkShadow = c.ink;
          buildPanel();
          requestRender('look');
          commit();
        },
      }, 'Invert'),
      h('button', {
        class: 'mini',
        onclick: () => {
          state.color.inkShadow = state.color.ink;
          buildPanel();
          requestRender('look');
          commit();
        },
      }, 'Single ink'),
    ),
  );

  // Composition
  const comp = section(panel, 'Composition', 'comp', { open: false });
  for (const def of LOOK.comp) comp.body.append(bindSlider(def, state.comp, 'shape', 'comp.' + def.key));

  // Export
  const ex = section(panel, 'Export', 'export');
  ex.body.append(
    selectRow('Size', RESOLUTIONS.map((r) => [r.id, r.label]), state.output, setOutput),
    resolution().custom ? h('div', { class: 'row custom-row' }, h('label', null, 'Width × height'), customSizeFields('panel')) : null,
    resolution().guide ? toggleRow('Show profile guide', guideOn(), (v) => {
      try {
        localStorage.setItem(GUIDE_KEY, v ? '1' : '0');
      } catch {}
      syncFrameUI();
    }) : null,
    h('button', { class: 'wide primary', onclick: exportPNG }, 'Export PNG'),
    subhead('Vector'),
    ...LOOK.svg.map((def) => bindSlider(def, state.svg, 'none')),
    selectRow('Opacity', [['varied', 'Varied (matches raster)'], ['solid', 'Solid stipple']], state.svg.opacity, (v) => {
      state.svg.opacity = v;
      commit();
    }),
    selectRow('Geometry', [['circles', 'Circles'], ['paths', 'Compact paths']], state.svg.geometry, (v) => {
      state.svg.geometry = v;
      commit();
    }),
    h('button', { class: 'wide', onclick: exportSVG }, 'Export SVG'),
    subhead('Settings'),
    h('div', { class: 'row buttons' },
      h('button', { class: 'mini', onclick: saveJSON, title: 'Download these settings as a JSON file' }, 'Save .json'),
      h('button', { class: 'mini', onclick: () => $('#file').click() }, 'Load…'),
      h('button', { class: 'mini', onclick: copyJSON }, 'Copy'),
      h('button', {
        class: 'mini ghost',
        onclick: () => replaceState({ ...defaultState(), output: state.output }, 'Reset all settings'),
      }, 'Reset all'),
    ),
    h('p', { class: 'note' }, 'Exported PNGs and SVGs carry their settings — drop one back on the window to restore it.'),
  );
  syncFrameUI();
}

// ---------- frame size ----------

const GUIDE_KEY = 'particle-shore:guide';
const frameSelect = $('#frame');
frameSelect.append(...RESOLUTIONS.map((r) => h('option', { value: r.id }, r.custom ? 'Custom size…' : `${r.short} · ${r.w}×${r.h}`)));
frameSelect.addEventListener('change', () => setOutput(frameSelect.value));
const topCustom = customSizeFields('top');
frameSelect.after(topCustom);

// Width × height fields for the custom size (top bar and Export panel).
function customSizeFields(where) {
  const field = (key, label) => {
    const input = h('input', { type: 'text', class: 'num', inputmode: 'numeric', spellcheck: 'false', 'aria-label': label, 'data-key': key });
    input.addEventListener('focus', () => input.select());
    input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
    input.addEventListener('change', () => setCustomSize({ ...state.custom, [key]: input.value }));
    return input;
  };
  const el = h('span', { class: 'custom-size ' + where },
    field('w', 'Custom width'),
    h('span', { class: 'times' }, '×'),
    field('h', 'Custom height'),
    h('button', {
      class: 'mini swap',
      title: 'Swap width and height',
      'aria-label': 'Swap width and height',
      onclick: () => setCustomSize({ w: state.custom.h, h: state.custom.w }),
    }, '⇄'),
  );
  el.update = () => {
    for (const input of el.querySelectorAll('input')) input.value = String(state.custom[input.dataset.key]);
  };
  el.update();
  return el;
}

function setCustomSize(size) {
  const next = clampCustom(size.w, size.h);
  const asked = Math.round(+size.w || 0) * Math.round(+size.h || 0);
  state.custom = next;
  if (next.w * next.h < asked) toast(`Custom sizes are limited to ${CUSTOM_LIMITS.max} px per side and 64 megapixels`, true);
  buildPanel();
  layout();
  requestRender('view');
  commit();
}

function guideOn() {
  try {
    return localStorage.getItem(GUIDE_KEY) !== '0';
  } catch {
    return true;
  }
}

function syncFrameUI() {
  frameSelect.value = state.output;
  topCustom.hidden = !resolution().custom;
  topCustom.update();
  $('#guide').hidden = !(resolution().guide === 'soundcloud' && guideOn());
}

function setOutput(id) {
  state.output = id;
  buildPanel();
  layout();
  requestRender('view');
  commit();
}

function syncControls(prefix, obj) {
  for (const [path, row] of controls) {
    if (path.startsWith(prefix + '.')) row.update(obj[path.slice(prefix.length + 1)]);
  }
}

// ---------- actions ----------

function newSeed() {
  state.seed = Math.floor(Math.random() * 100000);
  controls.get('seed')?.update(state.seed);
  requestRender('shape');
  commit();
}

function randomize() {
  const scene = SCENE_MAP[state.scene];
  const vals = state.shapes[state.scene];
  for (const p of scene.params) {
    const rr = p.rr ?? 0.35;
    if (!rr) continue;
    const span = (p.max - p.min) * rr;
    let v = p.def + (Math.random() * 2 - 1) * span;
    v = clamp(Math.round(v / p.step) * p.step, p.min, p.max);
    vals[p.key] = +v.toFixed(6);
  }
  state.seed = Math.floor(Math.random() * 100000);
  buildPanel();
  requestRender('shape');
  commit();
}

function settingsJSON() {
  return JSON.stringify(state);
}

function fileBase() {
  const r = resolution();
  return `particle-shore_${state.scene}_${state.seed}_${r.w}x${r.h}`;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const mb = (n) => (n / 1048576).toFixed(n > 10485760 ? 0 : 1) + ' MB';

function showOverlay(label, p) {
  const o = $('#overlay');
  o.hidden = false;
  o.querySelector('.ov-label').textContent = label;
  o.querySelector('.ov-bar i').style.width = Math.round(p * 100) + '%';
}

function hideOverlay() {
  $('#overlay').hidden = true;
}

async function exportPNG() {
  if (busy) return;
  busy = true;
  const res = resolution();
  const W = res.w, H = res.h;
  const transparent = state.color.transparent;
  const ch = transparent ? 4 : 3;
  const vScale = refScale(W, H);
  const fieldTexel = Math.max(1, Math.round(2 * vScale));
  const stride = W * ch + 1;
  const TILE = 2048;
  try {
    const raw = new Uint8Array(stride * H);
    const tiles = [];
    for (let y = 0; y < H; y += TILE) for (let x = 0; x < W; x += TILE) tiles.push([x, y, Math.min(TILE, W - x), Math.min(TILE, H - y)]);
    const buf = new Uint8Array(TILE * TILE * 4);
    const snapshot = structuredClone(state);
    for (let i = 0; i < tiles.length; i++) {
      showOverlay(`Rendering ${res.short} · tile ${i + 1} of ${tiles.length}`, (i / tiles.length) * 0.8);
      await nextFrame();
      const [tx, ty, tw, th] = tiles[i];
      const px = buf.subarray(0, tw * th * 4);
      renderer.renderTile(snapshot, { vOut: [W, H], region: [tx, ty, tw, th], vScale, fieldTexel }, transparent, px);
      for (let row = 0; row < th; row++) {
        const src = row * tw * 4;
        let o = (ty + row) * stride + 1 + tx * ch;
        if (ch === 4) raw.set(px.subarray(src, src + tw * 4), o);
        else for (let c = 0; c < tw; c++) {
          const s = src + c * 4;
          raw[o++] = px[s];
          raw[o++] = px[s + 1];
          raw[o++] = px[s + 2];
        }
      }
    }
    renderer.releaseSlot('tile');
    showOverlay('Encoding PNG…', 0.85);
    await nextFrame();
    const blob = await encodePNG(raw, W, H, ch, { Software: 'Particle Shore', 'particle-shore': JSON.stringify(snapshot) });
    download(blob, fileBase() + '.png');
    toast(`Exported ${W} × ${H} PNG · ${mb(blob.size)}`);
  } catch (e) {
    console.error(e);
    toast('PNG export failed: ' + e.message, true);
  } finally {
    hideOverlay();
    busy = false;
    requestRender('view');
  }
}

async function exportSVG() {
  if (busy) return;
  busy = true;
  const res = resolution();
  try {
    showOverlay('Sampling particles…', 0.2);
    await nextFrame();
    const pts = renderer.sampleParticles(state, { vOut: [res.w, res.h], budget: state.svg.budget, dotScale: state.svg.dotScale });
    showOverlay(`Writing ${fmtCount(pts.n)} particles…`, 0.6);
    await nextFrame();
    const blob = buildSVG({
      width: res.w,
      height: res.h,
      background: state.color.bg,
      transparent: state.color.transparent,
      pts,
      inks: [hexToRgb(state.color.inkShadow), hexToRgb(state.color.ink)],
      exposure: state.tone.exposure,
      opacity: state.svg.opacity,
      geometry: state.svg.geometry,
      meta: settingsJSON(),
    });
    download(blob, fileBase() + '.svg');
    toast(`Exported SVG · ${fmtCount(pts.n)} particles · ${mb(blob.size)}`);
  } catch (e) {
    console.error(e);
    toast('SVG export failed: ' + e.message, true);
  } finally {
    hideOverlay();
    busy = false;
    requestRender('view');
  }
}

function saveJSON() {
  download(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }), fileBase() + '.json');
}

async function copyJSON() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(state, null, 2));
    toast('Settings copied');
  } catch {
    toast('Clipboard not available', true);
  }
}

// Settings JSON from a PNG/SVG export, a settings file or a library backup.
async function readSettings(file) {
  let text = null;
  if (/\.png$/i.test(file.name) || file.type === 'image/png') text = readPNGText(await file.arrayBuffer(), 'particle-shore');
  else if (/\.svg$/i.test(file.name) || file.type === 'image/svg+xml') text = readSVGMeta(await file.text());
  else text = await file.text();
  if (!text) throw new Error('no Particle Shore settings found in this file');
  const obj = JSON.parse(text);
  if (obj.app !== 'particle-shore' && obj.app !== 'particle-shore-library') throw new Error('not a Particle Shore file');
  return obj;
}

async function loadFile(file) {
  try {
    const obj = await readSettings(file);
    if (obj.app === 'particle-shore-library') {
      openLibrary();
      await importIntoLibrary([file]);
      return;
    }
    replaceState(obj, `Loaded ${file.name}`);
  } catch (e) {
    toast('Could not load: ' + e.message, true);
  }
}

// ---------- library ----------

const libEl = $('#library');
let libUrls = [];
let currentDesignId = null;

const libraryIsOpen = () => !libEl.hidden;
const fmtDate = (t) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const defaultName = (st) => `${SCENE_MAP[st.scene].name} · ${resolutionOf(st).short}`;

function openLibrary() {
  libEl.hidden = false;
  $('#lib-btn').classList.add('on');
  renderLibrary();
}

function closeLibrary() {
  libEl.hidden = true;
  $('#lib-btn').classList.remove('on');
  libUrls.forEach((u) => URL.revokeObjectURL(u));
  libUrls = [];
}

// Small JPEG preview of a design, rendered at its own aspect ratio.
function makeThumb(st) {
  const r = resolutionOf(st);
  const s = Math.min(480 / r.w, 300 / r.h);
  const tw = Math.max(8, Math.round(r.w * s)), th = Math.max(8, Math.round(r.h * s));
  const px = new Uint8Array(tw * th * 4);
  renderer.renderTile(st, { vOut: [tw, th], region: [0, 0, tw, th], vScale: refScale(tw, th), fieldTexel: 1 }, false, px);
  renderer.releaseSlot('tile');
  const c = document.createElement('canvas');
  c.width = tw;
  c.height = th;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer), tw, th), 0, 0);
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.86));
}

async function saveToLibrary() {
  try {
    const snapshot = structuredClone(state);
    const now = Date.now();
    const item = { id: newId(), name: defaultName(snapshot), created: now, updated: now, state: snapshot, thumb: await makeThumb(snapshot) };
    await putDesign(item);
    currentDesignId = item.id;
    toast(`Saved “${item.name}” to the library`);
    if (libraryIsOpen()) renderLibrary();
  } catch (e) {
    toast('Could not save: ' + e.message, true);
  }
  requestRender('view');
}

function openDesign(item) {
  currentDesignId = item.id;
  closeLibrary();
  replaceState(item.state, `Opened “${item.name}”`);
}

// A button that needs a second click within 3 s to act.
function confirmButton(label, confirmLabel, action) {
  const b = h('button', { class: 'mini ghost' }, label);
  let timer = 0;
  b.addEventListener('click', async () => {
    if (!timer) {
      b.textContent = confirmLabel;
      b.classList.add('armed');
      timer = setTimeout(() => {
        timer = 0;
        b.textContent = label;
        b.classList.remove('armed');
      }, 3000);
      return;
    }
    clearTimeout(timer);
    b.disabled = true;
    try {
      await action();
    } catch (e) {
      toast(e.message, true);
      b.disabled = false;
    }
  });
  return b;
}

function libraryCard(item) {
  const st = normalizeState(item.state);
  const r = resolutionOf(st);
  const url = item.thumb ? URL.createObjectURL(item.thumb) : '';
  if (url) libUrls.push(url);
  const name = h('input', { type: 'text', class: 'lib-name', value: item.name, spellcheck: 'false', 'aria-label': 'Design name' });
  name.addEventListener('keydown', (e) => e.key === 'Enter' && name.blur());
  name.addEventListener('change', async () => {
    item.name = name.value.trim() || item.name;
    name.value = item.name;
    try {
      await putDesign(item);
    } catch (e) {
      toast('Could not rename: ' + e.message, true);
    }
  });
  const update = confirmButton('Update', 'Overwrite?', async () => {
    item.state = structuredClone(state);
    item.updated = Date.now();
    item.thumb = await makeThumb(item.state);
    await putDesign(item);
    currentDesignId = item.id;
    toast(`Updated “${item.name}” with the current design`);
    renderLibrary();
    requestRender('view');
  });
  const remove = confirmButton('Delete', 'Delete?', async () => {
    await deleteDesign(item.id);
    if (currentDesignId === item.id) currentDesignId = null;
    renderLibrary();
  });
  update.title = 'Replace this saved design with what is on the canvas';
  return h('div', { class: 'lib-card' + (item.id === currentDesignId ? ' current' : '') },
    h('button', { class: 'lib-thumb', title: 'Open this design', onclick: () => openDesign(item) }, url ? h('img', { src: url, alt: '' }) : null),
    name,
    h('div', { class: 'lib-meta' }, `${SCENE_MAP[st.scene].name} · ${r.w}×${r.h} · ${fmtDate(item.updated)}`),
    h('div', { class: 'lib-card-actions' }, h('button', { class: 'mini', onclick: () => openDesign(item) }, 'Open'), update, remove),
  );
}

async function renderLibrary() {
  let items;
  try {
    items = await listDesigns();
  } catch (e) {
    libEl.replaceChildren(h('div', { class: 'lib-empty' }, 'The library is not available in this browser: ' + e.message));
    return;
  }
  libUrls.forEach((u) => URL.revokeObjectURL(u));
  libUrls = [];
  const head = h('div', { class: 'lib-head' },
    h('div', { class: 'lib-title' }, 'Library', items.length ? h('span', { class: 'lib-count' }, String(items.length)) : null),
    h('div', { class: 'lib-actions' },
      h('button', { class: 'primary', onclick: saveToLibrary }, 'Save current design'),
      h('button', { onclick: () => $('#lib-file').click(), title: 'Add designs from a library backup, settings file or exported PNG/SVG' }, 'Import…'),
      h('button', { onclick: exportLibrary, disabled: !items.length, title: 'Download every saved design as one backup file' }, 'Export all'),
      h('button', { class: 'icon', onclick: closeLibrary, 'aria-label': 'Close library', title: 'Close (Esc)' }, '✕'),
    ),
  );
  const body = items.length
    ? h('div', { class: 'lib-grid' }, items.map(libraryCard))
    : h('div', { class: 'lib-empty' },
      h('strong', null, 'Nothing saved yet'),
      h('p', null, 'Save the current design to keep it here. You can also import a library backup, a settings file or any PNG/SVG exported from Particle Shore.'));
  libEl.replaceChildren(head, body, h('p', { class: 'lib-note' }, 'Designs are stored in this browser. Use Export all to back them up or move them to another browser or computer.'));
}

async function exportLibrary() {
  try {
    const items = await listDesigns();
    const data = {
      app: 'particle-shore-library',
      v: 1,
      exported: new Date().toISOString(),
      designs: items.map(({ id, name, created, updated, state: st }) => ({ id, name, created, updated, state: st })),
    };
    download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `particle-shore-library_${new Date().toISOString().slice(0, 10)}.json`);
    toast(`Exported ${items.length} design${items.length === 1 ? '' : 's'}`);
  } catch (e) {
    toast('Could not export the library: ' + e.message, true);
  }
}

async function importIntoLibrary(files) {
  let added = 0;
  for (const file of files) {
    try {
      const obj = await readSettings(file);
      const designs = obj.app === 'particle-shore-library' ? obj.designs || [] : [{ name: file.name.replace(/\.[^.]+$/, ''), state: obj }];
      for (const d of designs) {
        const st = normalizeState(d.state);
        const now = Date.now();
        await putDesign({
          id: typeof d.id === 'string' ? d.id : newId(),
          name: typeof d.name === 'string' && d.name ? d.name : defaultName(st),
          created: +d.created || now,
          updated: +d.updated || now,
          state: st,
          thumb: await makeThumb(st),
        });
        added++;
      }
    } catch (e) {
      toast(`Could not import ${file.name}: ${e.message}`, true);
    }
  }
  if (added) toast(`Imported ${added} design${added === 1 ? '' : 's'} into the library`);
  if (libraryIsOpen()) renderLibrary();
  requestRender('view');
}

// ---------- toast / fatal ----------

let toastTimer = 0;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 5000 : 2600);
}

function fatal(msg) {
  document.body.append(h('div', { class: 'fatal' }, h('div', null, h('strong', null, 'Particle Shore needs WebGL2'), h('p', null, msg))));
}

// ---------- canvas interaction ----------

// Composition units per CSS pixel of the preview (the design frame is 2 units tall).
function designUnit(rect) {
  const { w: W, h: H } = resolution();
  return (2 * frameK(W, H)) / rect.height;
}

let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, y: e.clientY, comp: { ...state.comp }, cx: view.cx, cy: view.cy };
  canvas.classList.add('grabbing');
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  const rect = canvas.getBoundingClientRect();
  if (view.mode === 'fit') {
    const u = designUnit(rect);
    state.comp.x = clamp(drag.comp.x + dx * u, -3, 3);
    state.comp.y = clamp(drag.comp.y - dy * u, -3, 3);
    syncControls('comp', state.comp);
    requestRender('shape', true);
  } else {
    const { w: W, h: H } = resolution();
    const dpr = canvas.width / rect.width;
    view.cx = clamp(drag.cx - (dx * dpr) / W, 0, 1);
    view.cy = clamp(drag.cy - (dy * dpr) / H, 0, 1);
    requestRender('view');
  }
});
const endDrag = () => {
  if (!drag) return;
  drag = null;
  canvas.classList.remove('grabbing');
  if (view.mode === 'fit') {
    requestRender('shape');
    commit();
  }
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

canvas.addEventListener('dblclick', (e) => {
  const rect = canvas.getBoundingClientRect();
  if (view.mode === 'fit') {
    view.cx = (e.clientX - rect.left) / rect.width;
    view.cy = (e.clientY - rect.top) / rect.height;
    setView('actual');
  } else {
    setView('fit');
  }
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  if (view.mode === 'actual') {
    const { w: W, h: H } = resolution();
    const dpr = canvas.width / rect.width;
    view.cx = clamp(view.cx + (e.deltaX * dpr) / W, 0, 1);
    view.cy = clamp(view.cy + (e.deltaY * dpr) / H, 0, 1);
    requestRender('view');
    return;
  }
  const c = state.comp;
  if (e.ctrlKey || e.metaKey) {
    // zoom around the cursor
    const u = designUnit(rect);
    const px = (e.clientX - rect.left - rect.width / 2) * u;
    const py = (rect.height / 2 - (e.clientY - rect.top)) * u;
    const z1 = c.zoom;
    const z2 = clamp(z1 * Math.exp(-e.deltaY * 0.01), 0.2, 6);
    c.x = clamp(px - ((px - c.x) * z2) / z1, -3, 3);
    c.y = clamp(py - ((py - c.y) * z2) / z1, -3, 3);
    c.zoom = z2;
  } else {
    const u = designUnit(rect);
    c.x = clamp(c.x - e.deltaX * u, -3, 3);
    c.y = clamp(c.y + e.deltaY * u, -3, 3);
  }
  syncControls('comp', c);
  requestRender('shape', true);
  commitSoon();
}, { passive: false });

// ---------- top bar, keys, drag & drop ----------

$('#undo').addEventListener('click', undo);
$('#redo').addEventListener('click', redo);
$('#seed').addEventListener('click', newSeed);
$('#shuffle').addEventListener('click', randomize);
$('#png').addEventListener('click', exportPNG);
$('#save-btn').addEventListener('click', saveToLibrary);
$('#lib-btn').addEventListener('click', () => (libraryIsOpen() ? closeLibrary() : openLibrary()));
document.querySelectorAll('#viewseg button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('#file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) loadFile(f);
  e.target.value = '';
});
$('#lib-file').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) importIntoLibrary(files);
});

window.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t.matches?.('input[type=text], input[type=number], select, textarea');
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z' && !typing) {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if (mod && k === 'y' && !typing) {
    e.preventDefault();
    redo();
    return;
  }
  if (mod && k === 's') {
    e.preventDefault();
    saveToLibrary();
    return;
  }
  if (k === 'escape' && libraryIsOpen()) {
    closeLibrary();
    return;
  }
  if (mod || typing || e.altKey) return;
  if (k === 'l') libraryIsOpen() ? closeLibrary() : openLibrary();
  else if (k === 'f') setView('fit');
  else if (k === '1') setView('actual');
  else if (k === 'r') randomize();
  else if (k === 's') newSeed();
  else if (k === 'e') exportPNG();
});

const drop = $('#drop');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  dragDepth++;
  drop.hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    drop.hidden = true;
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

window.addEventListener('pagehide', () => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {}
});

canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  toast('The GPU context was lost — reload the page to continue.', true);
});

// ---------- boot ----------

buildPanel();
setView('fit');
layout();
requestRender('shape');
