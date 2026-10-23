import * as SH from './shaders.js';
import { SCENE_MAP, sceneUniforms } from './scenes.js';

// Reference frame: all sizes and densities are expressed in 4K pixels
// (2160 px tall). Other output sizes render the same image at another scale.
export const REF_H = 2160;
const DESIGN_ASPECT = 16 / 9;
const CELL = 16;          // candidate grid cell, in reference px
const CHUNK = 1 << 22;    // vertices per draw call
const TF_CHUNK = 1 << 20; // vertices per transform-feedback readback
const DEG = Math.PI / 180;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    console.error(log + '\n' + src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n'));
    throw new Error('Shader compile failed: ' + log);
  }
  return sh;
}

class Program {
  constructor(gl, vs, fs, tfVaryings) {
    this.gl = gl;
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    if (tfVaryings) gl.transformFeedbackVaryings(p, tfVaryings, gl.INTERLEAVED_ATTRIBS);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
    this.p = p;
    this.u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      this.u[info.name.replace(/\[0\]$/, '')] = { loc: gl.getUniformLocation(p, info.name), type: info.type };
    }
  }
  use() {
    this.gl.useProgram(this.p);
    return this;
  }
  set(values) {
    const gl = this.gl;
    for (const k in values) {
      const u = this.u[k];
      if (!u) continue;
      const v = values[k];
      switch (u.type) {
        case gl.FLOAT: gl.uniform1f(u.loc, v); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
        case gl.INT: case gl.BOOL: case gl.SAMPLER_2D: gl.uniform1i(u.loc, v); break;
        case gl.INT_VEC2: gl.uniform2iv(u.loc, v); break;
        case gl.UNSIGNED_INT: gl.uniform1ui(u.loc, v); break;
      }
    }
    return this;
  }
}

// Every output shows the same 16:9 design frame, cropped to cover it, so a
// wide banner is a strip through the middle of the composition.
// frameK: visible fraction of the design frame's height.
export function frameK(w, h) {
  const a = w / h;
  return a > DESIGN_ASPECT ? DESIGN_ASPECT / a : 1;
}

// Virtual px per reference px when rendering a w×h output at full size.
export function refScale(w, h) {
  return h / frameK(w, h) / REF_H;
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.maxPoint = Math.min(256, gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1]);
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.float = !!gl.getExtension('EXT_color_buffer_float') && this.probeFloat();
    this.fieldEnc = this.float ? 0 : 1;
    this.formats = {
      field: this.float
        ? { internal: gl.RGBA16F, filter: gl.LINEAR }
        : { internal: gl.RGBA8, filter: gl.LINEAR },
      accum: this.float
        ? { internal: gl.RGBA16F, filter: gl.NEAREST }
        : { internal: gl.RGBA8, filter: gl.NEAREST },
      comp: { internal: gl.RGBA8, filter: gl.LINEAR },
    };
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.fieldProgs = new Map();
    this.particle = new Program(gl, SH.particleVS(false), SH.PARTICLE_FS);
    this.particleTF = new Program(gl, SH.particleVS(true), SH.TF_FS, ['v_d0', 'v_d1']);
    this.composite = new Program(gl, SH.FULLSCREEN_VS, SH.COMPOSITE_FS);
    this.present = new Program(gl, SH.FULLSCREEN_VS, SH.PRESENT_FS);
    this.targets = new Map();
  }

  probeFloat() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, 4, 4);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    return ok;
  }

  fieldProgram(sceneId) {
    let p = this.fieldProgs.get(sceneId);
    if (!p) {
      p = new Program(this.gl, SH.FULLSCREEN_VS, SH.fieldFS(SCENE_MAP[sceneId]));
      this.fieldProgs.set(sceneId, p);
    }
    return p;
  }

  target(name, w, h, kind) {
    const gl = this.gl;
    let t = this.targets.get(name);
    if (t && t.w === w && t.h === h && t.kind === kind) return t;
    if (t) this.freeTarget(name);
    if (w > this.maxTex || h > this.maxTex) throw new Error(`Render target ${w}×${h} exceeds GPU limit ${this.maxTex}`);
    const fmt = this.formats[kind];
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, fmt.internal, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, fmt.filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, fmt.filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    t = { tex, fbo, w, h, kind, key: null };
    this.targets.set(name, t);
    return t;
  }

  freeTarget(name) {
    const t = this.targets.get(name);
    if (!t) return;
    this.gl.deleteFramebuffer(t.fbo);
    this.gl.deleteTexture(t.tex);
    this.targets.delete(name);
  }

  releaseSlot(slot) {
    for (const name of [...this.targets.keys()]) if (name.startsWith(slot + ':')) this.freeTarget(name);
  }

  // Blocks until the GPU has finished; used for timing and before readbacks.
  sync(t) {
    const gl = this.gl;
    if (t) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      const float = t.kind !== 'comp' && this.float;
      gl.readPixels(0, 0, 1, 1, gl.RGBA, float ? gl.FLOAT : gl.UNSIGNED_BYTE, float ? new Float32Array(4) : new Uint8Array(4));
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    }
  }

  // spec: { vOut:[w,h], region:[x,y,w,h], vScale, fieldTexel } — all in virtual px.
  prepareField(state, spec, slot) {
    const gl = this.gl;
    const { vOut, region, vScale, fieldTexel } = spec;
    const fm = Math.ceil((128 * Math.max(vScale, 1)) / 8) * 8;
    const ox = region[0] - fm, oy = region[1] - fm;
    const fw = Math.max(1, Math.ceil((region[2] + 2 * fm) / fieldTexel));
    const fh = Math.max(1, Math.ceil((region[3] + 2 * fm) / fieldTexel));
    const t = this.target(slot + ':field', fw, fh, 'field');
    const c = state.comp;
    const key = JSON.stringify([state.scene, state.shapes[state.scene], state.seed, c, vOut, ox, oy, fieldTexel, fw, fh]);
    const info = { tex: t.tex, target: t, origin: [ox, oy], span: [fw * fieldTexel, fh * fieldTexel], margin: fm, rendered: false };
    if (t.key === key) return info;
    const scene = SCENE_MAP[state.scene];
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, fw, fh);
    gl.disable(gl.BLEND);
    this.fieldProgram(state.scene).use().set({
      u_vOut: vOut,
      u_frameK: frameK(vOut[0], vOut[1]),
      u_fieldOrigin: [ox, oy],
      u_fieldTexel: fieldTexel,
      u_seed: state.seed,
      u_comp: [c.x, c.y, Math.max(c.zoom, 1e-3), c.rotate * DEG],
      u_enc: this.fieldEnc,
      ...sceneUniforms(scene, state.shapes[state.scene]),
    });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    t.key = key;
    info.rendered = true;
    return info;
  }

  layout(state, spec, margin) {
    const P = state.particles;
    const [rx, ry, rw, rh] = spec.region;
    const cellSize = CELL * spec.vScale;
    const perCell = Math.max(1, Math.round(P.density * CELL * CELL));
    const cx0 = Math.floor((rx - margin) / cellSize), cy0 = Math.floor((ry - margin) / cellSize);
    const cx1 = Math.floor((rx + rw + margin) / cellSize), cy1 = Math.floor((ry + rh + margin) / cellSize);
    const cellsW = cx1 - cx0 + 1, cellsH = cy1 - cy0 + 1;
    return {
      cellSize, perCell, cx0, cy0, cellsW, cellsH,
      total: cellsW * cellsH * perCell,
      eFactor: (P.density * cellSize * cellSize) / perCell,
    };
  }

  particleUniforms(state, spec, field, lay) {
    const P = state.particles, T = state.tone, C = state.color;
    return {
      u_field: 0,
      u_enc: this.fieldEnc,
      u_fieldOrigin: field.origin,
      u_fieldSpan: field.span,
      u_region: spec.region,
      u_vOut: spec.vOut,
      u_cell0: [lay.cx0, lay.cy0],
      u_cellsW: lay.cellsW,
      u_perCell: lay.perCell,
      u_cellSize: lay.cellSize,
      u_idOffset: 0,
      u_seed: state.seed >>> 0,
      u_vScale: spec.vScale,
      u_eFactor: lay.eFactor,
      u_maxPoint: this.maxPoint,
      u_size: P.size,
      u_sizeVar: P.sizeVar,
      u_int: P.intensity,
      u_intVar: P.intensityVar,
      u_scatter: P.scatter,
      u_drift: P.drift,
      u_driftScale: P.driftScale,
      u_softness: P.softness,
      u_gain: T.gain,
      u_black: T.black,
      u_contrast: T.contrast,
      u_invert: T.invert ? 1 : 0,
      u_vignette: T.vignette,
      u_dust: T.dust,
      u_ink: hexToRgb(C.ink),
      u_inkShadow: hexToRgb(C.inkShadow),
    };
  }

  drawParticles(state, spec, field, slot) {
    const gl = this.gl;
    const P = state.particles;
    const [, , rw, rh] = spec.region;
    const maxSize = P.size * Math.pow(2, P.sizeVar * 1.5) * 4;
    const margin = Math.min(field.margin, Math.ceil((maxSize * 0.5 + 3 * P.scatter + 2 * P.drift) * spec.vScale + 2));
    const lay = this.layout(state, spec, margin);
    const accum = this.target(slot + ':accum', rw, rh, 'accum');
    gl.bindFramebuffer(gl.FRAMEBUFFER, accum.fbo);
    gl.viewport(0, 0, rw, rh);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, field.tex);
    const prog = this.particle.use().set(this.particleUniforms(state, spec, field, lay));
    for (let off = 0; off < lay.total; off += CHUNK) {
      prog.set({ u_idOffset: off });
      gl.drawArrays(gl.POINTS, 0, Math.min(CHUNK, lay.total - off));
    }
    gl.disable(gl.BLEND);
    return { accum, total: lay.total };
  }

  compose(state, spec, accum, slot, transparent) {
    const gl = this.gl;
    const [, , rw, rh] = spec.region;
    const comp = this.target(slot + ':comp', rw, rh, 'comp');
    gl.bindFramebuffer(gl.FRAMEBUFFER, comp.fbo);
    gl.viewport(0, 0, rw, rh);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, accum.tex);
    this.composite.use().set({
      u_accum: 0,
      u_bg: hexToRgb(state.color.bg),
      u_exposure: state.tone.exposure,
      u_transparent: transparent ? 1 : 0,
    });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return comp;
  }

  presentTarget(comp, checker) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, comp.tex);
    this.present.use().set({
      u_tex: 0,
      u_srcSize: [comp.w, comp.h],
      u_dstSize: [this.canvas.width, this.canvas.height],
      u_checker: checker ? 1 : 0,
    });
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Interactive view: render the region, then box-filter it into the canvas.
  renderView(state, spec) {
    const transparent = state.color.transparent;
    const t0 = performance.now();
    const field = this.prepareField(state, spec, 'view');
    let fieldMs = null;
    if (field.rendered) {
      this.sync(field.target);
      fieldMs = performance.now() - t0;
    }
    const t1 = performance.now();
    const { accum, total } = this.drawParticles(state, spec, field, 'view');
    const comp = this.compose(state, spec, accum, 'view', transparent);
    this.presentTarget(comp, transparent);
    this.sync();
    return { fieldMs, particleMs: performance.now() - t1, candidates: total };
  }

  // Export tile: renders one region at full resolution and reads it back.
  renderTile(state, spec, transparent, out) {
    const gl = this.gl;
    const field = this.prepareField(state, spec, 'tile');
    const { accum } = this.drawParticles(state, spec, field, 'tile');
    const comp = this.compose(state, spec, accum, 'tile', transparent);
    gl.bindFramebuffer(gl.FRAMEBUFFER, comp.fbo);
    gl.readPixels(0, 0, spec.region[2], spec.region[3], gl.RGBA, gl.UNSIGNED_BYTE, out);
  }

  // Runs the particle shader with transform feedback and returns the
  // accepted particles (used for SVG). Same code path as the raster render.
  captureParticles(state, spec, field, { maxCount = Infinity, countOnly = false } = {}) {
    const gl = this.gl;
    const lay = this.layout(state, spec, 0);
    const [W, H] = spec.vOut;
    if (!this.tfBuf) {
      this.tfBuf = gl.createBuffer();
      gl.bindBuffer(gl.COPY_READ_BUFFER, this.tfBuf);
      gl.bufferData(gl.COPY_READ_BUFFER, TF_CHUNK * 32, gl.STREAM_READ);
      gl.bindBuffer(gl.COPY_READ_BUFFER, null);
      this.tf = gl.createTransformFeedback();
      this.tfData = new Float32Array(TF_CHUNK * 8);
    }
    const cols = { x: [], y: [], size: [], intensity: [], tone: [] };
    let accepted = 0;
    // the field may still be attached to the bound framebuffer (feedback loop)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, field.tex);
    const prog = this.particleTF.use().set(this.particleUniforms(state, spec, field, lay));
    gl.enable(gl.RASTERIZER_DISCARD);
    const buf = this.tfData;
    for (let off = 0; off < lay.total; off += TF_CHUNK) {
      const n = Math.min(TF_CHUNK, lay.total - off);
      prog.set({ u_idOffset: off });
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.tf);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.tfBuf);
      gl.beginTransformFeedback(gl.POINTS);
      gl.drawArrays(gl.POINTS, 0, n);
      gl.endTransformFeedback();
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
      gl.bindBuffer(gl.COPY_READ_BUFFER, this.tfBuf);
      gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, buf, 0, n * 8);
      gl.bindBuffer(gl.COPY_READ_BUFFER, null);
      for (let i = 0; i < n; i++) {
        const o = i * 8;
        if (buf[o + 7] < 0.5) continue;
        const x = buf[o], y = buf[o + 1];
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        accepted++;
        if (countOnly) continue;
        cols.x.push(x); cols.y.push(y); cols.size.push(buf[o + 2]); cols.intensity.push(buf[o + 3]); cols.tone.push(buf[o + 4]);
      }
    }
    gl.disable(gl.RASTERIZER_DISCARD);
    if (countOnly) return { accepted, candidates: lay.total };
    // thin uniformly if we overshot the budget
    let idx = null;
    if (accepted > maxCount) {
      const keep = maxCount / accepted;
      idx = [];
      for (let i = 0; i < accepted; i++) if (Math.random() < keep) idx.push(i);
    }
    const pick = (arr) => Float32Array.from(idx ? idx.map((i) => arr[i]) : arr);
    return {
      n: idx ? idx.length : accepted,
      x: pick(cols.x), y: pick(cols.y), size: pick(cols.size), intensity: pick(cols.intensity), tone: pick(cols.tone),
    };
  }

  // Particles for vector export: fewer, larger dots that keep the same
  // average light as the raster render.
  sampleParticles(state, { vOut, budget, dotScale }) {
    const vScale = refScale(vOut[0], vOut[1]);
    const spec = { vOut, region: [0, 0, vOut[0], vOut[1]], vScale, fieldTexel: Math.max(1, Math.round(2 * vScale)) };
    const field = this.prepareField(state, spec, 'svg');
    const refArea = (vOut[0] * vOut[1]) / (vScale * vScale);
    const pilotDensity = Math.max(1 / 256, 300000 / refArea);
    const pilotState = { ...state, particles: { ...state.particles, density: pilotDensity } };
    const pilot = this.captureParticles(pilotState, spec, field, { countOnly: true });
    const rate = pilot.accepted / Math.max(1, pilot.candidates);
    let density = Math.min(state.particles.density, budget / Math.max(rate * refArea, 1e-9));
    density = Math.max(1, Math.round(density * CELL * CELL)) / (CELL * CELL);
    const sizeMul = Math.sqrt(state.particles.density / density) * dotScale;
    const svgState = { ...state, particles: { ...state.particles, density, size: state.particles.size * sizeMul } };
    const pts = this.captureParticles(svgState, spec, field, { maxCount: budget });
    this.releaseSlot('svg');
    return pts;
  }
}
