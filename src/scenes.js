// Each scene is a GLSL function `vec2 scene(vec2 q)` returning
// (light, grain scale). q is the composed frame coordinate: y in [-1, 1] up,
// x in [-aspect, aspect]. Every param becomes a `uniform float u_<key>`.
// `rad` params are entered in degrees and passed in radians. `rr` is the
// fraction of the range Randomize may move the value (default 0.35).

const DEG = Math.PI / 180;

const P = (key, label, min, max, step, def, opt = {}) => ({ key, label, min, max, step, def, ...opt });
const group = (name, list) => list.map((p) => ({ ...p, group: name }));
const deg = (opt = {}) => ({ unit: '°', rad: true, ...opt });

const dunes = {
  id: 'dunes',
  name: 'Dunes',
  blurb: 'Raymarched sand under a grazing sun',
  icon: '<path d="M2 15c4-6 8-7 12-3s6 3 8 1" /><path d="M2 9c3-3 6-3 9-1s5 2 7 0" opacity=".5"/>',
  params: [
    ...group('Light', [
      P('sunAz', 'Sun direction', -180, 180, 0.5, 100, deg()),
      P('sunEl', 'Sun height', 0.5, 60, 0.1, 14, deg()),
      P('sunI', 'Sun strength', 0, 4, 0.01, 2.6),
      P('focus', 'Light focus', 0.5, 8, 0.01, 2, { hint: 'Narrows the lit band on each face' }),
      P('sheen', 'Sheen', 0, 3, 0.01, 1.2),
      P('shadowSoft', 'Shadow softness', 0, 1, 0.01, 0.5),
      P('ambient', 'Ambient', 0, 0.3, 0.001, 0.012),
    ]),
    ...group('Terrain', [
      P('scale', 'Wavelength', 3, 60, 0.1, 20),
      P('amp', 'Height', 0.1, 10, 0.01, 4),
      P('sharp', 'Crest sharpness', 0, 1, 0.01, 0.75),
      P('asym', 'Asymmetry', 0, 0.95, 0.01, 0.55),
      P('meander', 'Meander', 0, 2, 0.01, 1.2),
      P('cross', 'Cross dunes', 0, 1, 0.01, 0),
      P('ripple', 'Ripples', 0, 1, 0.01, 0, { rr: 0.2 }),
      P('wind', 'Wind direction', -180, 180, 0.5, 55, deg({ rr: 0.15 })),
    ]),
    ...group('Camera', [
      P('camH', 'Height', 0.2, 20, 0.01, 4, { rr: 0.08 }),
      P('pitch', 'Pitch', -45, 20, 0.1, -10, deg({ rr: 0.08 })),
      P('yaw', 'Yaw', -180, 180, 0.5, 25, deg({ rr: 0.1 })),
      P('fov', 'Field of view', 10, 100, 0.5, 42, deg({ rr: 0.1 })),
      P('travel', 'Travel', -300, 300, 0.1, 0),
      P('fog', 'Depth fade', 0, 6, 0.01, 0.7),
      P('horizon', 'Sky glow', 0, 1, 0.01, 0, { rr: 0 }),
      P('persp', 'Grain perspective', 0, 1, 0.01, 0.7, { rr: 0 }),
    ]),
  ],
  glsl: /* glsl */ `
// One wavelength: a convex windward body rising to a sharp brink,
// then a steep slip face easing into the trough.
float duneProfile(float ph) {
  float f = fract(ph);
  float c = mix(0.5, 0.9, u_asym);
  float a = 1.0 - f / c;
  float windward = 1.0 - a * a;
  float slip = pow(max(1.0 - (f - c) / (1.0 - c), 0.0), 1.4);
  float g = f < c ? 0.5 * f / c : 0.5 + 0.5 * (f - c) / (1.0 - c);
  float roundP = 0.5 - 0.5 * cos(g * TAU);
  return mix(roundP, f < c ? windward : slip, u_sharp);
}
float terrain(vec2 xz) {
  vec2 q = rot2(u_wind) * xz / u_scale;
  // bend the crests: a broad meander plus a little finer wobble
  float m = fbm(q * 0.22 + SO, 4) * u_meander * 2.6 + gnoise(q * 0.9 + SO.yx) * u_meander * 0.18;
  float h = duneProfile(q.y + m);
  // let dunes swell, shrink and merge along their length
  h *= sat(0.62 + 1.1 * gnoise(q * vec2(0.16, 0.3) + SO.yx * 1.3));
  vec2 q2 = rot2(0.7) * q;
  h += u_cross * 0.4 * (0.5 - 0.5 * cos(TAU * (q2.y * 1.7 + m * 0.5))) * sat(0.5 + gnoise(q2 * 0.3 + SO));
  h *= u_amp;
  if (u_ripple > 0.0) {
    vec2 rq = rot2(u_wind + 0.2) * xz;
    h += u_ripple * 0.05 * sin(rq.y * 7.0 + gnoise(xz * 0.6 + SO) * 5.0);
  }
  return h;
}
vec2 scene(vec2 p) {
  float fl = 1.0 / tan(u_fov * 0.5);
  vec3 rd = normalize(vec3(p, fl));
  float cp = cos(u_pitch), sp = sin(u_pitch);
  rd = vec3(rd.x, rd.y * cp + rd.z * sp, rd.z * cp - rd.y * sp);
  rd.xz = rot2(u_yaw) * rd.xz;
  vec3 ro = vec3(0.0, 0.0, u_travel);
  ro.y = terrain(ro.xz) + u_camH;
  vec3 sun = normalize(vec3(cos(u_sunEl) * sin(u_sunAz), sin(u_sunEl), cos(u_sunEl) * cos(u_sunAz)));
  float sky = u_horizon * (exp(-max(rd.y, 0.0) * 14.0) * 0.8 + 0.6 * pow(sat(dot(rd, sun)), 12.0));

  float t = 0.0, lt = 0.0, ld = 0.0, hit = -1.0;
  for (int i = 0; i < 200; i++) {
    vec3 pos = ro + rd * t;
    float d = pos.y - terrain(pos.xz);
    if (d < 0.0) { hit = lt + (t - lt) * ld / (ld - d); break; }
    lt = t; ld = d;
    t += clamp(d * 0.45, 0.01 + t * 0.003, 2.0 + t * 0.05);
    if (t > 600.0) break;
  }
  if (hit < 0.0) return vec2(sky, 1.0);

  vec3 pos = ro + rd * hit;
  float e = 0.015 + hit * 0.002;
  vec3 n = normalize(vec3(
    terrain(pos.xz - vec2(e, 0.0)) - terrain(pos.xz + vec2(e, 0.0)),
    2.0 * e,
    terrain(pos.xz - vec2(0.0, e)) - terrain(pos.xz + vec2(0.0, e))));
  float ndl = dot(n, sun);
  float dif = pow(sat(ndl), u_focus);
  float sh = 1.0;
  if (ndl > 0.0) {
    float k = mix(40.0, 3.0, u_shadowSoft);
    float st = 0.05;
    vec3 o = pos + n * 0.02;
    for (int i = 0; i < 64; i++) {
      vec3 sp3 = o + sun * st;
      float hh = sp3.y - terrain(sp3.xz);
      sh = min(sh, k * hh / st);
      if (sh < 0.001 || st > 150.0) break;
      st += clamp(hh * 0.5, 0.05, 2.5 + st * 0.05);
    }
    sh = sat(sh);
  }
  vec3 hv = normalize(sun - rd);
  float spec = pow(sat(dot(n, hv)), 6.0 + 10.0 * u_focus) * u_sheen * smoothstep(0.0, 0.08, ndl);
  float L = (u_sunI * dif + spec) * sh + u_ambient * (0.35 + 0.65 * n.y);
  L = mix(sky, L, exp(-hit * u_fog * 0.01));
  float S = pow(clamp(12.0 / hit, 0.25, 4.0), u_persp);
  return vec2(L, S);
}`,
};

const beam = {
  id: 'beam',
  name: 'Light beam',
  blurb: 'A shaft of light cut by a lit wall',
  icon: '<path d="M2 5l12 4v6L2 19z" /><path d="M16 6v12" opacity=".6"/><path d="M18 7v10" opacity=".3"/>',
  params: [
    ...group('Beam', [
      P('ox', 'Origin X', -3.5, 2, 0.001, -2.55),
      P('oy', 'Origin Y', -2, 2, 0.001, 0.12),
      P('angle', 'Direction', -90, 90, 0.1, -5, deg({ rr: 0.15 })),
      P('width', 'Width', 0.02, 2.5, 0.001, 0.95),
      P('spread', 'Spread', -40, 40, 0.1, -11, deg({ rr: 0.2 })),
      P('hard', 'Edge hardness', 1, 14, 0.01, 2.4),
      P('falloff', 'Falloff', 0, 2, 0.001, 0.12),
      P('beamI', 'Strength', 0, 2, 0.001, 0.8),
    ]),
    ...group('Core', [
      P('coreI', 'Core strength', 0, 4, 0.01, 1.3),
      P('coreW', 'Core width', 0.02, 1.2, 0.001, 0.24),
      P('coreOff', 'Core offset', -1, 1, 0.001, -0.04),
      P('coreTilt', 'Core tilt', -30, 30, 0.1, -3, deg()),
    ]),
    ...group('Wall', [
      P('cutX', 'Edge position', -2, 2.5, 0.001, 0.42),
      P('cutSoft', 'Edge softness', 0, 0.4, 0.001, 0.004, { rr: 0.05 }),
      P('slabI', 'Wall light', 0, 2, 0.001, 0.72),
      P('slabW', 'Wall width', 0.05, 1.6, 0.001, 0.42),
      P('slabTop', 'Wall top', -1, 1.4, 0.001, 0.68),
      P('slabBot', 'Wall bottom', -1.4, 1, 0.001, -0.74),
      P('slabFall', 'Wall falloff', 0, 10, 0.01, 2.8),
      P('slabSoft', 'Wall softness', 0.001, 0.8, 0.001, 0.28),
    ]),
    ...group('Air', [
      P('haze', 'Haze', 0, 1, 0.001, 0.22),
      P('hazeScale', 'Haze scale', 0.2, 10, 0.01, 1.8),
      P('ambient', 'Ambient', 0, 0.2, 0.001, 0, { rr: 0 }),
    ]),
  ],
  glsl: /* glsl */ `
vec2 scene(vec2 q) {
  vec2 dir = vec2(cos(u_angle), sin(u_angle));
  vec2 nrm = vec2(-dir.y, dir.x);
  vec2 d = q - vec2(u_ox, u_oy);
  float t = dot(d, dir);
  float s = dot(d, nrm);
  float w = max(u_width + t * tan(u_spread), 0.002);
  float env = exp(-pow(abs(s) / w, u_hard));
  float along = smoothstep(-0.05, 0.25, t) * exp(-max(t, 0.0) * u_falloff);
  float cs = (s - u_coreOff - t * tan(u_coreTilt)) / u_coreW;
  float core = u_coreI * exp(-cs * cs);
  float haze = max(1.0 + u_haze * fbm(q * u_hazeScale + SO, 4) * 2.2, 0.0);
  float beamL = u_beamI * along * env * (1.0 + core) * haze;
  beamL *= 1.0 - smoothstep(u_cutX - u_cutSoft - 0.001, u_cutX, q.x);

  float u = (q.x - u_cutX) / u_slabW;
  float yv = smoothstep(u_slabBot, u_slabBot + u_slabSoft, q.y) * (1.0 - smoothstep(u_slabTop - u_slabSoft, u_slabTop, q.y));
  float mid = (u_slabTop + u_slabBot) * 0.5;
  float span = max((u_slabTop - u_slabBot) * 0.5, 0.01);
  float yy = (q.y - mid) / span;
  float prof = exp(-yy * yy * 0.7);
  float edge = smoothstep(-0.002 - u_cutSoft * 0.25, 0.0, q.x - u_cutX);
  float slab = u_slabI * edge * exp(-max(u, 0.0) * u_slabFall) * (1.0 - smoothstep(0.6, 1.0, u)) * yv * mix(0.55, 1.0, prof);
  slab *= max(1.0 + u_haze * 0.6 * fbm(q * u_hazeScale * 1.3 + SO.yx, 3), 0.0);
  return vec2(beamL + slab + u_ambient, 1.0);
}`,
};

const orb = {
  id: 'orb',
  name: 'Orb',
  blurb: 'A lit sphere with a soft terminator',
  icon: '<circle cx="12" cy="12" r="8" /><path d="M12 4a8 8 0 0 1 0 16a5 8 0 0 0 0-16z" fill="currentColor" stroke="none" opacity=".55"/>',
  params: [
    ...group('Shape', [
      P('cx', 'Center X', -2.5, 2.5, 0.001, 0.18),
      P('cy', 'Center Y', -1.8, 1.8, 0.001, 0),
      P('radius', 'Radius', 0.05, 3, 0.001, 0.74),
    ]),
    ...group('Light', [
      P('lightAz', 'Light direction', -180, 180, 0.5, 28, deg()),
      P('lightEl', 'Light depth', -80, 80, 0.5, -8, deg()),
      P('lightI', 'Strength', 0, 3, 0.01, 1.25),
      P('wrap', 'Terminator softness', 0, 1, 0.01, 0.12),
      P('hard', 'Falloff', 0.3, 4, 0.01, 1.2),
      P('rim', 'Rim light', 0, 2, 0.01, 0.3),
      P('rimPow', 'Rim width', 0.5, 10, 0.01, 4),
      P('ambient', 'Ambient', 0, 0.3, 0.001, 0.008),
    ]),
    ...group('Surface', [
      P('bump', 'Relief', 0, 3, 0.01, 0.7),
      P('bumpScale', 'Relief scale', 0.5, 14, 0.01, 3.2),
    ]),
    ...group('Halo', [
      P('halo', 'Halo', 0, 2, 0.01, 0.3),
      P('haloSize', 'Halo size', 0.005, 1.5, 0.001, 0.14),
    ]),
  ],
  glsl: /* glsl */ `
vec2 scene(vec2 q) {
  vec2 d = (q - vec2(u_cx, u_cy)) / u_radius;
  float r2 = dot(d, d);
  float rr = sqrt(r2);
  vec3 l = normalize(vec3(cos(u_lightEl) * cos(u_lightAz), cos(u_lightEl) * sin(u_lightAz), sin(u_lightEl)));
  vec2 lxy = normalize(l.xy + vec2(1e-4, 0.0));
  float L = 0.0;
  if (r2 < 1.0) {
    vec3 n = vec3(d, sqrt(1.0 - r2));
    if (u_bump > 0.0) {
      vec2 bp = n.xy / (1.0 + n.z) * u_bumpScale + SO;
      float e = 0.01;
      float b0 = fbm(bp, 5);
      float bx = fbm(bp + vec2(e, 0.0), 5);
      float by = fbm(bp + vec2(0.0, e), 5);
      n = normalize(n - u_bump * 0.12 * vec3((bx - b0) / e, (by - b0) / e, 0.0));
    }
    float dif = pow(sat((dot(n, l) + u_wrap) / (1.0 + u_wrap)), u_hard);
    float rim = u_rim * pow(1.0 - n.z, u_rimPow) * sat(dot(normalize(d + 1e-5), lxy) * 0.5 + 0.5);
    L = (u_lightI * dif + rim + u_ambient) * (1.0 - smoothstep(0.992, 1.0, rr));
  }
  float side = 0.5 + 0.5 * dot(normalize(d + 1e-5), lxy);
  L += u_halo * exp(-max(rr - 1.0, 0.0) * u_radius / u_haloSize) * side * smoothstep(0.985, 1.0, rr);
  return vec2(L, 1.0);
}`,
};

const silk = {
  id: 'silk',
  name: 'Silk',
  blurb: 'Folded cloth under raking light',
  icon: '<path d="M2 8c4-4 7 4 10 0s7 4 10 0" /><path d="M2 14c4-4 7 4 10 0s7 4 10 0" opacity=".6"/><path d="M2 20c4-4 7 4 10 0s7 4 10 0" opacity=".3"/>',
  params: [
    ...group('Folds', [
      P('scale', 'Scale', 0.2, 6, 0.001, 2),
      P('angle', 'Direction', -180, 180, 0.5, 28, deg()),
      P('folds', 'Layers', 1, 6, 1, 5, { rr: 0.2 }),
      P('flow', 'Flow', 0, 3, 0.01, 0.8),
      P('rough', 'Roughness', 0.1, 0.9, 0.01, 0.5),
      P('warp', 'Bend', 0, 3, 0.01, 1),
      P('depth', 'Depth', 0.1, 6, 0.01, 2.5),
    ]),
    ...group('Light', [
      P('lightAz', 'Light direction', -180, 180, 0.5, 120, deg()),
      P('lightEl', 'Light height', 2, 89, 0.5, 20, deg()),
      P('lightI', 'Strength', 0, 3, 0.01, 1.15),
      P('power', 'Falloff', 0.5, 6, 0.01, 2),
      P('sheen', 'Sheen', 0, 2, 0.01, 0.7),
      P('gloss', 'Gloss', 2, 128, 0.5, 30),
      P('ambient', 'Ambient', 0, 0.3, 0.001, 0, { rr: 0 }),
    ]),
  ],
  glsl: /* glsl */ `
// Long folds running along x, bent slowly along their length; finer
// layers ride on top at slightly different angles.
float silkH(vec2 q) {
  vec2 p = rot2(-u_angle) * q * u_scale;
  float bend = fbm(vec2(p.x * 0.16, p.y * 0.06) + SO, 3) * u_warp * 3.0;
  float h = 0.0, a = 1.0, f = 1.0;
  int n = int(u_folds + 0.5);
  for (int i = 0; i < 6; i++) {
    if (i >= n) break;
    float fi = float(i);
    vec2 r = rot2(0.18 * sin(fi * 2.3)) * p;
    h += a * sin(r.y * f + bend * sqrt(f) + u_flow * sin(r.x * 0.35 * sqrt(f) + fi * 2.1) + fi * 1.3);
    f *= 1.75;
    a *= u_rough;
  }
  return h;
}
vec2 scene(vec2 q) {
  float e = 0.002;
  float h0 = silkH(q);
  float hx = silkH(q + vec2(e, 0.0));
  float hy = silkH(q + vec2(0.0, e));
  vec2 g = vec2(hx - h0, hy - h0) / e;
  vec3 n = normalize(vec3(-g * u_depth * 0.25 / u_scale, 1.0));
  vec3 l = normalize(vec3(cos(u_lightEl) * cos(u_lightAz), cos(u_lightEl) * sin(u_lightAz), sin(u_lightEl)));
  float dif = pow(sat(dot(n, l)), u_power);
  vec3 hv = normalize(l + vec3(0.0, 0.0, 1.0));
  float spec = pow(sat(dot(n, hv)), u_gloss) * u_sheen;
  float ao = 0.55 + 0.45 * sat(h0 * 0.3 + 0.5);
  return vec2((u_lightI * dif + spec) * ao + u_ambient, 1.0);
}`,
};

const halo = {
  id: 'halo',
  name: 'Eclipse',
  blurb: 'A ring of light with a corona',
  icon: '<circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="10" opacity=".3"/>',
  params: [
    ...group('Ring', [
      P('cx', 'Center X', -2.5, 2.5, 0.001, 0),
      P('cy', 'Center Y', -1.8, 1.8, 0.001, 0),
      P('radius', 'Radius', 0.05, 2.5, 0.001, 0.58),
      P('thick', 'Thickness', 0.002, 0.4, 0.001, 0.03),
      P('ringI', 'Strength', 0, 3, 0.01, 1.3),
      P('squash', 'Perspective', 0.08, 1, 0.001, 1, { rr: 0.25 }),
      P('tilt', 'Tilt', -90, 90, 0.1, 0, deg()),
    ]),
    ...group('Light', [
      P('crescent', 'Crescent', 0, 1, 0.01, 0.72),
      P('phase', 'Light direction', -180, 180, 0.5, 58, deg()),
      P('inner', 'Inner glow', 0, 2, 0.01, 0.22),
      P('occlude', 'Dark disk', 0, 1, 0.01, 1, { rr: 0 }),
    ]),
    ...group('Corona', [
      P('corona', 'Corona', 0, 2, 0.01, 0.55),
      P('coronaLen', 'Reach', 0.02, 2, 0.001, 0.3),
      P('rays', 'Ray count', 0.5, 24, 0.01, 5.5),
      P('rayAmt', 'Ray contrast', 0, 1, 0.01, 0.65),
    ]),
  ],
  glsl: /* glsl */ `
vec2 scene(vec2 q) {
  vec2 d = rot2(-u_tilt) * (q - vec2(u_cx, u_cy));
  d.y /= u_squash;
  float r = length(d);
  vec2 dir = d / max(r, 1e-5);
  float a = atan(d.y, d.x);
  float cres = mix(1.0, pow(0.5 + 0.5 * cos(a - u_phase), 1.5), u_crescent);
  float x = (r - u_radius) / u_thick;
  float ring = u_ringI * exp(-x * x);
  float rays = mix(1.0, sat(0.5 + 1.6 * fbm(dir * u_rays + SO, 4)), u_rayAmt);
  float outside = smoothstep(u_radius - u_thick, u_radius + u_thick, r);
  float corona = u_corona * exp(-max(r - u_radius, 0.0) / u_coronaLen) * rays * outside;
  float base = (ring + corona) * mix(1.0, smoothstep(u_radius - u_thick * 2.0, u_radius, r), u_occlude);
  float inner = u_inner * exp(-max(u_radius - r, 0.0) / (u_radius * 0.3)) * (1.0 - outside);
  return vec2((base + inner) * cres, 1.0);
}`,
};

const nebula = {
  id: 'nebula',
  name: 'Smoke',
  blurb: 'Domain-warped clouds and smoke',
  icon: '<path d="M4 15a4 4 0 0 1 4-6a5 5 0 0 1 9 1a3.5 3.5 0 0 1 1 7H7a3 3 0 0 1-3-2z" />',
  params: [
    ...group('Form', [
      P('scale', 'Scale', 0.2, 5, 0.001, 1.05),
      P('detail', 'Detail', 1, 8, 1, 6, { rr: 0.2 }),
      P('warp', 'Warp', 0, 2, 0.001, 1.3),
      P('ridge', 'Filaments', 0, 1, 0.01, 0.5),
      P('angle', 'Flow direction', -180, 180, 0.5, 18, deg()),
      P('stretch', 'Stretch', 0.3, 4, 0.01, 1.7),
    ]),
    ...group('Tone', [
      P('bias', 'Fill', -1, 1, 0.001, -0.15),
      P('contrastN', 'Contrast', 0.2, 4, 0.01, 1.8),
      P('mask', 'Center mask', 0, 1, 0.01, 0.6),
      P('maskR', 'Mask radius', 0.3, 3, 0.01, 1.7),
    ]),
  ],
  glsl: /* glsl */ `
vec2 scene(vec2 q) {
  vec2 p = rot2(u_angle) * q;
  p.x /= u_stretch;
  p *= u_scale;
  int oct = int(u_detail + 0.5);
  vec2 o1 = vec2(fbm(p + SO, 4), fbm(p + SO + vec2(5.2, 1.3), 4));
  vec2 o2 = vec2(fbm(p + 3.0 * u_warp * o1 + vec2(1.7, 9.2), 4), fbm(p + 3.0 * u_warp * o1 + vec2(8.3, 2.8), 4));
  float n = fbm(p + 3.0 * u_warp * o2 + SO.yx, oct);
  float ridged = pow(sat(1.0 - abs(n) * 3.0), 3.0);
  float v = mix(n + 0.5, ridged, u_ridge);
  v = sat((v - 0.5) * u_contrastN + 0.5 + u_bias);
  float m = 1.0 - smoothstep(u_maskR * 0.35, u_maskR, length(q));
  v *= mix(1.0, m, u_mask);
  return vec2(v, 1.0);
}`,
};

export const SCENES = [dunes, beam, orb, silk, halo, nebula];
export const SCENE_MAP = Object.fromEntries(SCENES.map((s) => [s.id, s]));

export function sceneDefaults(scene) {
  return Object.fromEntries(scene.params.map((p) => [p.key, p.def]));
}

export function sceneUniforms(scene, values) {
  const u = {};
  for (const p of scene.params) {
    const v = values?.[p.key] ?? p.def;
    u['u_' + p.key] = p.rad ? v * DEG : v;
  }
  return u;
}
