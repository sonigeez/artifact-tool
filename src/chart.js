import { ToolError } from './store.js';

// Draws a chart as SVG from data rows, so printed values, positions and highlights
// always agree with the rows. Follows the guide: grey data, one accent, zero-based bars,
// finding in the title, only the points that matter labelled.
const INK = 'var(--cds-text-primary)';
const QUIET = 'var(--cds-text-secondary)';
const AXIS = 'var(--cds-chart-axis)';
const GRID = 'var(--cds-chart-grid)';
const MUTED = 'var(--cds-chart-muted)';
const ACCENT = 'var(--cds-chart-categorical-1)';
const REF = 'var(--cds-chart-reference)';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (n) => Number(n.toFixed(2)).toLocaleString('en-US');
const hover = (r, unit) => `<title>${esc(r.x)}: ${fmt(r.y)}${unit ? ` ${esc(unit)}` : ''}</title>`;
const text = (x, y, s, { anchor = 'middle', fill = INK, size, weight } = {}) =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}"${size ? ` font-size="${size}"` : ''}${weight ? ` font-weight="${weight}"` : ''} fill="${fill}">${esc(s)}</text>`;

function frame({ title, subtitle }, L, height, body) {
  return `<svg viewBox="0 0 760 ${height}" role="img" aria-label="${esc(title)}" font-size="12">`
    + text(L, 30, title, { anchor: 'start', size: 15, weight: 600 })
    + (subtitle ? text(L, 50, subtitle, { anchor: 'start', fill: QUIET, size: 11.5 }) : '')
    + body
    + '</svg>';
}

// A dashed reference line labelled in a margin reserved right of the plot, clear of every mark.
function sideReference(reference, x0, x1, yy) {
  return `<line x1="${x0}" x2="${x1}" y1="${yy}" y2="${yy}" stroke="${REF}" stroke-width="1.25" stroke-dasharray="4 4"/>`
    + text(x1 + 8, yy + 4, reference.label, { anchor: 'start', fill: QUIET, size: 11.5 })
    + text(x1 + 8, yy + 18, fmt(reference.value), { anchor: 'start', fill: QUIET, size: 11.5 });
}

function checkReference(reference) {
  if (reference && reference.label.length > 18) throw new ToolError('chart_invalid', 'reference label is too long (max 18 characters)');
}

function highlightIndex(rows, highlight, fallback) {
  if (highlight === undefined) return fallback;
  const i = rows.findIndex((r) => r.x === highlight);
  if (i < 0) throw new ToolError('chart_invalid', `highlight "${highlight}" is not one of the row labels`);
  return i;
}

function bar(spec) {
  const { rows, unit, reference } = spec;
  if (rows.some((r) => r.y < 0)) throw new ToolError('chart_invalid', 'bars start at zero and cannot be negative; use kind "line" for signed values');
  checkReference(reference);
  const L = 40, R = reference ? 620 : 720, base = 270, top = spec.subtitle ? 92 : 76;
  const max = Math.max(...rows.map((r) => r.y), reference?.value ?? 0) || 1;
  const band = (R - L) / rows.length;
  if (Math.max(...rows.map((r) => r.x.length)) * 6.4 > band - 4) {
    throw new ToolError('chart_invalid', 'category labels are too long for this many bars; shorten them or use kind "hbar"');
  }
  const hi = highlightIndex(rows, spec.highlight, rows.findIndex((r) => r.y === Math.max(...rows.map((q) => q.y))));
  const y = (v) => base - (v / max) * (base - top);
  const bw = Math.min(72, band * 0.6);
  // a value normally sits above its bar; where the reference line would cross it, it goes inside the bar top
  const valueY = (r, on) => (!on && reference && Math.abs(y(reference.value) - (y(r.y) - 12)) < 10 && base - y(r.y) > 30 ? y(r.y) + 18 : y(r.y) - 8);
  const marks = rows.map((r, i) => {
    const cx = L + i * band + band / 2;
    const on = i === hi;
    return `<g><rect x="${cx - bw / 2}" y="${y(r.y)}" width="${bw}" height="${base - y(r.y)}" rx="3" fill="${on ? ACCENT : MUTED}">${hover(r, unit)}</rect>`
      + (rows.length <= 8 || on ? text(cx, valueY(r, on), fmt(r.y), { weight: on ? 600 : undefined }) : '')
      + text(cx, base + 20, r.x, { fill: QUIET })
      + '</g>';
  });
  const ref = reference ? sideReference(reference, L, R, y(reference.value)) : '';
  return frame(spec, L, base + 40, `<line x1="${L}" x2="${R}" y1="${base}" y2="${base}" stroke="${AXIS}"/>${marks.join('')}${ref}`);
}

function hbar(spec) {
  const { rows, unit, reference } = spec;
  if (rows.some((r) => r.y < 0)) throw new ToolError('chart_invalid', 'bars start at zero and cannot be negative; use kind "line" for signed values');
  checkReference(reference);
  const L = 40, R = 720, top = spec.subtitle ? 76 : 60, pitch = 30;
  const labelW = Math.ceil(Math.max(...rows.map((r) => r.x.length)) * 6.4) + 8;
  if (labelW > 260) throw new ToolError('chart_invalid', 'category labels are too long; shorten them');
  const x0 = L + labelW + 12;
  const len = R - x0 - 56;
  const max = Math.max(...rows.map((r) => r.y), reference?.value ?? 0) || 1;
  const hi = highlightIndex(rows, spec.highlight, rows.findIndex((r) => r.y === Math.max(...rows.map((q) => q.y))));
  const marks = rows.map((r, i) => {
    const cy = top + i * pitch + pitch / 2;
    const w = (r.y / max) * len;
    const on = i === hi;
    return `<g>${text(L, cy + 4, r.x, { anchor: 'start', fill: on ? INK : QUIET, weight: on ? 600 : undefined })}`
      + `<rect x="${x0}" y="${cy - 9}" width="${w}" height="18" rx="3" fill="${on ? ACCENT : MUTED}">${hover(r, unit)}</rect>`
      + text(x0 + w + 8, cy + 4, fmt(r.y), { anchor: 'start', weight: on ? 600 : undefined })
      + '</g>';
  });
  const bottom = top + rows.length * pitch;
  const ref = reference
    ? `<line x1="${x0 + (reference.value / max) * len}" x2="${x0 + (reference.value / max) * len}" y1="${top}" y2="${bottom}" stroke="${REF}" stroke-width="1.25" stroke-dasharray="4 4"/>`
      + text(x0 + (reference.value / max) * len, top - 6, `${reference.label} · ${fmt(reference.value)}`, { fill: QUIET, size: 11.5 })
    : '';
  return frame(spec, L, bottom + 24, `<line x1="${x0}" x2="${x0}" y1="${top}" y2="${bottom}" stroke="${AXIS}"/>${marks.join('')}${ref}`);
}

function niceTicks(lo, hi) {
  if (lo >= 0 && lo < 0.4 * hi) lo = 0;
  const raw = (hi - lo || Math.abs(hi) || 1) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const out = [];
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 1e6; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

function line(spec) {
  const { rows, unit, reference } = spec;
  checkReference(reference);
  const L = 64, R = reference ? 600 : 704, base = 270, top = spec.subtitle ? 92 : 76;
  const values = rows.map((r) => r.y).concat(reference ? [reference.value] : []);
  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const lo = ticks[0], hiV = ticks.at(-1);
  const y = (v) => base - ((v - lo) / (hiV - lo)) * (base - top);
  const x = (i) => (rows.length === 1 ? (L + R) / 2 : L + (i * (R - L)) / (rows.length - 1));
  const hi = highlightIndex(rows, spec.highlight, rows.length - 1);
  const labelled = new Set([0, rows.length - 1, hi]);
  const m = Math.min(rows.length - 1, 5);
  const xLabels = new Set(Array.from({ length: m + 1 }, (_, j) => (m === 0 ? 0 : Math.round((j * (rows.length - 1)) / m))));
  const grid = ticks.map((t) => `<line x1="${L}" x2="${R}" y1="${y(t)}" y2="${y(t)}" stroke="${GRID}"/>${text(L - 8, y(t) + 4, fmt(t), { anchor: 'end', fill: QUIET, size: 11.5 })}`).join('');
  const path = rows.map((r, i) => `${i ? 'L' : 'M'}${x(i)} ${y(r.y)}`).join('');
  const dots = rows.map((r, i) => `<circle cx="${x(i)}" cy="${y(r.y)}" r="${i === hi ? 5 : 3}" fill="${ACCENT}">${hover(r, unit)}</circle>`).join('');
  const values_ = [...labelled].map((i) => text(x(i) + (i === 0 && rows.length > 1 ? 2 : 0), y(rows[i].y) - 12, fmt(rows[i].y), { anchor: i === 0 && rows.length > 1 ? 'start' : 'middle', weight: i === hi ? 600 : undefined })).join('');
  const axis = [...xLabels].map((i) => text(x(i), base + 20, rows[i].x, { fill: QUIET })).join('');
  const ref = reference ? sideReference(reference, L, R, y(reference.value)) : '';
  return frame(spec, L, base + 40, `<g>${grid}</g>${ref}<path d="${path}" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}${values_}${axis}`);
}

const DRAW = { bar, hbar, line };

export function renderChart(spec) {
  if (!spec.rows.length) throw new ToolError('chart_invalid', 'rows is empty');
  return DRAW[spec.kind](spec);
}
