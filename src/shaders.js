// GLSL sources. Coordinates: "virtual px" are output pixels at the current
// render scale (y down). Every offscreen texture stores row 0 = top of image.

export const NOISE = /* glsl */ `
#define PI 3.14159265359
#define TAU 6.28318530718
float sat(float x) { return clamp(x, 0.0, 1.0); }
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(hash22(i) * 2.0 - 1.0, f);
  float b = dot(hash22(i + vec2(1.0, 0.0)) * 2.0 - 1.0, f - vec2(1.0, 0.0));
  float c = dot(hash22(i + vec2(0.0, 1.0)) * 2.0 - 1.0, f - vec2(0.0, 1.0));
  float d = dot(hash22(i + vec2(1.0, 1.0)) * 2.0 - 1.0, f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p, int oct) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * gnoise(p);
    p = rot2(0.62) * p * 2.03 + vec2(17.1, 3.7);
    a *= 0.5;
  }
  return s;
}
`;

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Field pass: evaluates the scene into (luminance, grain scale).
export function fieldFS(scene) {
  const decls = scene.params.map((p) => `uniform float u_${p.key};`).join('\n');
  return /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 u_vOut;
uniform float u_frameK;
uniform vec2 u_fieldOrigin;
uniform float u_fieldTexel;
uniform float u_seed;
uniform vec4 u_comp;
uniform int u_enc;
out vec4 outColor;
${NOISE}
${decls}
vec2 SO;
${scene.glsl}
void main() {
  SO = (vec2(hash12(vec2(u_seed * 0.7311, 3.17)), hash12(vec2(u_seed * 1.3717, 7.73))) - 0.5) * 400.0;
  vec2 px = u_fieldOrigin + gl_FragCoord.xy * u_fieldTexel;
  vec2 n = px / u_vOut;
  float aspect = u_vOut.x / u_vOut.y;
  vec2 p = vec2((n.x - 0.5) * 2.0 * aspect, (0.5 - n.y) * 2.0) * u_frameK;
  vec2 q = rot2(-u_comp.w) * (p - u_comp.xy) / u_comp.z;
  vec2 r = scene(q);
  float L = isnan(r.x) ? 0.0 : max(r.x, 0.0);
  float S = isnan(r.y) ? 1.0 : clamp(r.y, 0.25, 4.0);
  if (u_enc == 1) outColor = vec4(sqrt(clamp(L * 0.25, 0.0, 1.0)), log2(S) * 0.25 + 0.5, 0.0, 1.0);
  else outColor = vec4(L, S, 0.0, 1.0);
}`;
}

// Particle pass. Candidates live in a global grid of cells (in reference px),
// so any tile or zoomed view regenerates exactly the same particles.
export function particleVS(tf) {
  return /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
${tf ? '#define TF 1' : ''}
uniform sampler2D u_field;
uniform int u_enc;
uniform vec2 u_fieldOrigin;
uniform vec2 u_fieldSpan;
uniform vec4 u_region;
uniform vec2 u_vOut;
uniform ivec2 u_cell0;
uniform int u_cellsW;
uniform int u_perCell;
uniform float u_cellSize;
uniform int u_idOffset;
uniform uint u_seed;
uniform float u_vScale;
uniform float u_eFactor;
uniform float u_maxPoint;
uniform float u_size;
uniform float u_sizeVar;
uniform float u_int;
uniform float u_intVar;
uniform float u_scatter;
uniform float u_drift;
uniform float u_driftScale;
uniform float u_gain;
uniform float u_black;
uniform float u_contrast;
uniform int u_invert;
uniform float u_vignette;
uniform float u_dust;
uniform vec3 u_ink;
uniform vec3 u_inkShadow;
out vec4 v_color;
out float v_size;
#ifdef TF
out vec4 v_d0;
out vec4 v_d1;
#endif
${NOISE}
uint hash(uint x) {
  x ^= x >> 16u; x *= 0x7feb352du;
  x ^= x >> 15u; x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
float rnd(inout uint s) { s = hash(s); return float(s >> 8u) * (1.0 / 16777216.0); }

void reject() {
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  gl_PointSize = 1.0;
  v_color = vec4(0.0);
  v_size = 0.0;
#ifdef TF
  v_d0 = vec4(0.0);
  v_d1 = vec4(0.0);
#endif
}

void main() {
  int id = gl_VertexID + u_idOffset;
  int cl = id / u_perCell;
  int k = id - cl * u_perCell;
  int cx = u_cell0.x + cl % u_cellsW;
  int cy = u_cell0.y + cl / u_cellsW;
  uint s = hash(uint(cx + 65536) * 0x9E3779B1u ^ hash(uint(cy + 65536) * 0x85EBCA77u + u_seed));
  s = hash(s ^ (uint(k) * 0xC2B2AE3Du + 0x27D4EB2Fu));

  vec2 pos = (vec2(float(cx), float(cy)) + vec2(rnd(s), rnd(s))) * u_cellSize;
  vec4 f = textureLod(u_field, (pos - u_fieldOrigin) / u_fieldSpan, 0.0);
  float L = f.r, S = f.g;
  if (u_enc == 1) { L = f.r * f.r * 4.0; S = exp2((f.g - 0.5) * 4.0); }

  // tone -> acceptance probability
  float v = max(L * u_gain - u_black, 0.0) / max(1.0 - u_black, 1e-3);
  v = pow(v, u_contrast);
  if (u_invert == 1) v = 1.0 - sat(v);
  vec2 nrm = pos / u_vOut;
  v *= 1.0 - u_vignette * smoothstep(0.3, 1.5, length((nrm - 0.5) * 2.0));
  float P = v / (S * S) + u_dust;
  float tone = sat(v);
  float accept = rnd(s);
  float r1 = rnd(s), r2 = rnd(s), g1 = rnd(s), g2 = rnd(s);
  if (accept >= P) { reject(); return; }

  float sz = u_size * S * exp2((r1 * 2.0 - 1.0) * u_sizeVar * 1.5);
  float I = u_int * mix(1.0, -log(max(r2, 1e-6)), u_intVar);

  vec2 off = sqrt(-2.0 * log(max(g1, 1e-6))) * vec2(cos(TAU * g2), sin(TAU * g2)) * u_scatter;
  if (u_drift > 0.0) {
    float aspect = u_vOut.x / u_vOut.y;
    vec2 dp = nrm * vec2(aspect, 1.0) * u_driftScale + float(u_seed % 977u) * 0.37;
    off += vec2(gnoise(dp), gnoise(dp + vec2(19.1, 7.3))) * 2.0 * u_drift;
  }
  pos += off * u_vScale;

  float sv = sz * u_vScale;
  float ps = clamp(sv, 1.0, u_maxPoint);
  // keep average brightness independent of render scale and dot size
  float Iv = I * u_eFactor * (sz * sz) / (ps * ps);
  vec3 col = mix(u_inkShadow, u_ink, tone);

  vec2 clip = (pos - u_region.xy) / u_region.zw * 2.0 - 1.0;
  gl_Position = vec4(clip, 0.0, 1.0);
  gl_PointSize = ps;
  v_color = vec4(col * Iv, Iv);
  v_size = ps;
#ifdef TF
  v_d0 = vec4(pos, sv, I);
  v_d1 = vec4(tone, 0.0, 0.0, 1.0);
#endif
}`;
}

export const PARTICLE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec4 v_color;
in float v_size;
uniform float u_softness;
out vec4 o;
void main() {
  float a = 1.0;
  if (v_size > 1.5) {
    float d = length(gl_PointCoord * 2.0 - 1.0);
    float aa = 2.0 / v_size;
    a = 1.0 - smoothstep(1.0 - max(u_softness, aa), 1.0, d);
    if (a <= 0.0) discard;
  }
  o = v_color * a;
}`;

export const TF_FS = /* glsl */ `#version 300 es
precision highp float;
out vec4 o;
void main() { o = vec4(0.0); }`;

// Accumulated light -> image. Additive energy is tone-mapped with 1 - e^-x,
// which is also what stacked semi-transparent dots converge to.
export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_accum;
uniform vec3 u_bg;
uniform float u_exposure;
uniform int u_transparent;
out vec4 o;
void main() {
  vec4 a = texelFetch(u_accum, ivec2(gl_FragCoord.xy), 0);
  float E = a.a;
  vec3 ink = E > 1e-6 ? a.rgb / E : vec3(0.0);
  float c = 1.0 - exp(-E * u_exposure);
  if (u_transparent == 1) o = vec4(ink, c);
  else o = vec4(mix(u_bg, ink, c), 1.0);
}`;

// Box-filtered downsample of the full-resolution image into the canvas.
export const PRESENT_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_srcSize;
uniform vec2 u_dstSize;
uniform int u_checker;
out vec4 o;
void main() {
  vec2 fc = vec2(gl_FragCoord.x, u_dstSize.y - gl_FragCoord.y);
  vec2 uv = fc / u_dstSize;
  vec2 ratio = u_srcSize / u_dstSize;
  vec4 acc = vec4(0.0);
  if (ratio.x <= 1.001 && ratio.y <= 1.001) {
    vec4 c = texture(u_tex, uv);
    acc = vec4(c.rgb * c.a, c.a);
  } else {
    int n = int(clamp(ceil(max(ratio.x, ratio.y)), 1.0, 8.0));
    vec2 base = uv * u_srcSize - ratio * 0.5;
    for (int j = 0; j < 8; j++) {
      if (j >= n) break;
      for (int i = 0; i < 8; i++) {
        if (i >= n) break;
        vec2 sp = base + (vec2(float(i), float(j)) + 0.5) * ratio / float(n);
        vec4 c = texture(u_tex, sp / u_srcSize);
        acc += vec4(c.rgb * c.a, c.a);
      }
    }
    acc /= float(n * n);
  }
  vec3 bg = vec3(0.0);
  if (u_checker == 1) {
    vec2 cc = floor(gl_FragCoord.xy / 10.0);
    bg = mix(vec3(0.13), vec3(0.18), mod(cc.x + cc.y, 2.0));
  }
  o = vec4(acc.rgb + bg * (1.0 - acc.a), 1.0);
}`;
