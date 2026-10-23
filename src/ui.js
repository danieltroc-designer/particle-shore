// Small DOM helpers for the control panel.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const decimals = (step) => (step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step) - 1e-9)));

function readOpen(id, fallback) {
  try {
    const v = localStorage.getItem('particle-shore:open:' + id);
    return v == null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function writeOpen(id, open) {
  try {
    localStorage.setItem('particle-shore:open:' + id, open ? '1' : '0');
  } catch {}
}

export function section(parent, title, id, { open = true, actions } = {}) {
  const isOpen = readOpen(id, open);
  const body = h('div', { class: 'sec-body' });
  const head = h('div', { class: 'sec-head', role: 'button', tabindex: '0' },
    h('span', { class: 'chev' }),
    h('span', { class: 'sec-title' }, title),
    actions ? h('span', { class: 'sec-actions' }, actions) : null,
  );
  const el = h('section', { class: 'sec' + (isOpen ? ' open' : '') }, head, body);
  const toggle = (e) => {
    if (e.target.closest('.sec-actions')) return;
    el.classList.toggle('open');
    writeOpen(id, el.classList.contains('open'));
  };
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle(e)));
  parent.append(el);
  return { el, body };
}

export function subhead(text) {
  return h('div', { class: 'subhead' }, text);
}

// def: { label, min, max, step, def, unit, hint }
export function slider(def, value, { onInput, onCommit }) {
  const dec = decimals(def.step);
  const fmt = (v) => Number(v).toFixed(dec);
  const range = h('input', { type: 'range', min: def.min, max: def.max, step: def.step, 'aria-label': def.label });
  const num = h('input', { type: 'text', class: 'num', inputmode: 'decimal', spellcheck: 'false', 'aria-label': def.label + ' value' });
  const label = h('label', { title: (def.hint ? def.hint + '\n' : '') + 'Double-click to reset' }, def.label);
  const fill = (v) => range.style.setProperty('--p', (((v - def.min) / (def.max - def.min)) * 100).toFixed(2) + '%');
  const show = (v) => {
    range.value = v;
    num.value = fmt(v);
    fill(v);
  };
  show(value);
  const set = (v) => {
    v = clamp(+v, def.min, def.max);
    if (!Number.isFinite(v)) return show(range.value);
    show(v);
    onInput(v, false);
    onCommit?.();
  };
  range.addEventListener('input', () => {
    num.value = fmt(range.value);
    fill(+range.value);
    onInput(+range.value, true);
  });
  range.addEventListener('change', () => onCommit?.());
  num.addEventListener('change', () => set(num.value));
  num.addEventListener('focus', () => num.select());
  num.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') num.blur();
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const k = (e.shiftKey ? 10 : 1) * def.step * (e.key === 'ArrowUp' ? 1 : -1);
      set(+range.value + k);
    }
  });
  label.addEventListener('dblclick', () => set(def.def));
  const row = h('div', { class: 'row slider' }, label, range, h('div', { class: 'numwrap' }, num, def.unit ? h('span', { class: 'unit' }, def.unit) : null));
  row.update = show;
  return row;
}

export function colorRow(label, value, { onInput, onCommit }) {
  const picker = h('input', { type: 'color', value, 'aria-label': label });
  const text = h('input', { type: 'text', class: 'num hex', value, spellcheck: 'false', 'aria-label': label + ' hex' });
  picker.addEventListener('input', () => {
    text.value = picker.value;
    onInput(picker.value);
  });
  picker.addEventListener('change', () => onCommit?.());
  text.addEventListener('change', () => {
    let v = text.value.trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#[0-9a-f]{3}$/i.test(v)) v = '#' + [...v.slice(1)].map((c) => c + c).join('');
    if (!/^#[0-9a-f]{6}$/i.test(v)) return (text.value = picker.value);
    picker.value = v.toLowerCase();
    text.value = picker.value;
    onInput(picker.value);
    onCommit?.();
  });
  return h('div', { class: 'row color' }, h('label', null, label), h('div', { class: 'swatch' }, picker), text);
}

export function toggleRow(label, value, onChange) {
  const input = h('input', { type: 'checkbox', 'aria-label': label });
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'row toggle' }, h('span', null, label), h('span', { class: 'switch' }, input, h('i')));
}

export function selectRow(label, options, value, onChange) {
  const sel = h('select', { 'aria-label': label }, options.map(([v, text]) => h('option', { value: v }, text)));
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  return h('div', { class: 'row select' }, h('label', null, label), sel);
}
