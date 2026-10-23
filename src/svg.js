// Vector export: one element per particle, grouped by color and opacity so
// the file stays editable (and as small as it can be) in design tools.

const num = (v) => String(Math.round(v * 10) / 10);
const hex2 = (c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0');

// pts: { n, x, y, size (diameter), intensity, tone }; inks: [shadowRgb, lightRgb]
export function buildSVG({ width, height, background, transparent, pts, inks, exposure, opacity, geometry, meta }) {
  const paths = geometry === 'paths';
  const [lo, hi] = inks;
  const duotone = lo.some((c, k) => c !== hi[k]);
  const palette = Array.from({ length: 17 }, (_, t) => '#' + lo.map((c, k) => hex2(c + (hi[k] - c) * (t / 16))).join(''));
  const groups = new Map();
  for (let i = 0; i < pts.n; i++) {
    let a = opacity === 'solid' ? 1 : 1 - Math.exp(-pts.intensity[i] * exposure);
    a = Math.round(a * 24) / 24;
    if (a <= 0) continue;
    const color = palette[duotone ? Math.round(pts.tone[i] * 16) : 16];
    const rad = Math.max(0.05, pts.size[i] * 0.5);
    const rq = paths ? Math.max(0.05, Math.round(rad * 20) / 20) : 0;
    const key = color + a + (paths ? '/' + rq : '');
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { color, a, rq, parts: [] }));
    if (paths) g.parts.push('M' + num(pts.x[i]) + ' ' + num(pts.y[i]) + 'h0');
    else g.parts.push('<circle cx="' + num(pts.x[i]) + '" cy="' + num(pts.y[i]) + '" r="' + Math.round(rad * 100) / 100 + '"/>');
  }
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n`,
  ];
  if (meta) out.push(`<metadata id="particle-shore"><![CDATA[${meta}]]></metadata>\n`);
  if (!transparent) out.push(`<rect width="${width}" height="${height}" fill="${background}"/>\n`);
  for (const g of [...groups.values()].sort((x, y) => x.a - y.a)) {
    const op = +g.a.toFixed(3);
    if (paths) {
      out.push(`<path fill="none" stroke="${g.color}" stroke-opacity="${op}" stroke-width="${+(g.rq * 2).toFixed(2)}" stroke-linecap="round" d="${g.parts.join('')}"/>\n`);
    } else {
      out.push(`<g fill="${g.color}" fill-opacity="${op}">`, g.parts.join(''), '</g>\n');
    }
  }
  out.push('</svg>\n');
  return new Blob(out, { type: 'image/svg+xml' });
}

export function readSVGMeta(text) {
  const m = /<metadata id="particle-shore"><!\[CDATA\[([\s\S]*?)\]\]><\/metadata>/.exec(text);
  return m ? m[1] : null;
}
