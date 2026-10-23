import { Renderer, hexToRgb, frameK, refScale } from './renderer.js';
import { SCENES, SCENE_MAP, sceneDefaults } from './scenes.js';
import { LOOK, RESOLUTIONS, PRESETS, defaultState, normalizeState, applyPreset } from './params.js';
import { h, section, subhead, slider, colorRow, toggleRow, selectRow } from './ui.js';
import { encodePNG, readPNGText } from './png.js';
import { buildSVG, readSVGMeta } from './svg.js';

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
  return RESOLUTIONS.find((r) => r.id === state.output) || RESOLUTIONS[0];
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
      h('button', { class: 'mini', onclick: saveJSON, title: 'Save settings as JSON (⌘S)' }, 'Save .json'),
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
frameSelect.append(...RESOLUTIONS.map((r) => h('option', { value: r.id }, `${r.short} · ${r.w}×${r.h}`)));
frameSelect.addEventListener('change', () => setOutput(frameSelect.value));

function guideOn() {
  try {
    return localStorage.getItem(GUIDE_KEY) !== '0';
  } catch {
    return true;
  }
}

function syncFrameUI() {
  frameSelect.value = state.output;
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

async function loadFile(file) {
  try {
    let text = null;
    if (/\.png$/i.test(file.name) || file.type === 'image/png') text = readPNGText(await file.arrayBuffer(), 'particle-shore');
    else if (/\.svg$/i.test(file.name) || file.type === 'image/svg+xml') text = readSVGMeta(await file.text());
    else text = await file.text();
    if (!text) throw new Error('no Particle Shore settings found in this file');
    const obj = JSON.parse(text);
    if (obj.app !== 'particle-shore') throw new Error('not a Particle Shore settings file');
    replaceState(obj, `Loaded ${file.name}`);
  } catch (e) {
    toast('Could not load: ' + e.message, true);
  }
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
document.querySelectorAll('#viewseg button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('#file').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) loadFile(f);
  e.target.value = '';
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
    saveJSON();
    return;
  }
  if (mod || typing || e.altKey) return;
  if (k === 'f') setView('fit');
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
