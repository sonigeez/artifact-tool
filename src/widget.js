// Validates agent-authored SVG before it is stored. The allowlist makes inline
// rendering safe; the token/size rules keep drawings legible in light and dark.
const ALLOWED = new Set([
  'svg', 'g', 'defs', 'marker', 'path', 'rect', 'circle', 'ellipse',
  'line', 'polyline', 'polygon', 'text', 'tspan', 'title', 'desc',
]);

export function validateSvg(svg) {
  const s = String(svg).trim();
  const errors = new Set();

  if (s.length > 1_000_000) errors.add('svg is larger than 1 MiB');
  if (!/^<svg[\s>]/.test(s) || !/<\/svg>$/.test(s)) errors.add('must be a single <svg>…</svg> element');

  const root = s.match(/^<svg\b[^>]*>/)?.[0] ?? '';
  if (!/viewBox\s*=\s*["']0 0 760 \d+(\.\d+)?["']/.test(root)) errors.add('root needs viewBox="0 0 760 H"');
  if (!/role\s*=\s*["']img["']/.test(root)) errors.add('root needs role="img"');
  if (!/aria-label\s*=\s*["'][^"']+["']/.test(root)) errors.add('root needs a non-empty aria-label (the title words)');

  for (const [, name] of s.matchAll(/<\/?([a-zA-Z][\w:-]*)/g)) {
    if (!ALLOWED.has(name)) errors.add(`<${name}> is not allowed`);
  }
  if (/<[!?]/.test(s)) errors.add('comments, doctype and processing instructions are not allowed');
  if (/\son\w+\s*=/i.test(s)) errors.add('event-handler attributes are not allowed');
  if (/\bhref\s*=/i.test(s)) errors.add('href is not allowed');
  if (/\sstyle\s*=/i.test(s)) errors.add('style attributes are not allowed; use presentation attributes');

  for (const [, attr, val] of s.matchAll(/\b(fill|stroke)\s*=\s*["']([^"']*)["']/g)) {
    if (!/^(none|var\(--cds-[\w-]+\)|url\(#[\w-]+\))$/.test(val.trim())) {
      errors.add(`${attr}="${val}": use none or a var(--cds-…) theme token`);
    }
  }
  if ([...s.matchAll(/<text\b[^>]*>/g)].some(([tag]) => !/\sfill\s*=/.test(tag))) {
    errors.add('every <text> needs a fill (unfilled text is black, unreadable in dark mode)');
  }
  if ([...s.matchAll(/font-size\s*=\s*["']([\d.]+)/g)].some(([, v]) => Number(v) < 10.5)) {
    errors.add('font-size must be at least 10.5');
  }
  return [...errors];
}
