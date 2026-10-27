import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderChart } from '../src/chart.js';
import { validateSvg } from '../src/widget.js';
import { Store } from '../src/store.js';
import { makeTools } from '../src/tools.js';

const days = [['Mon', 1200], ['Tue', 1450], ['Wed', 1840], ['Thu', 1610], ['Fri', 1320]].map(([x, y]) => ({ x, y }));
const spec = (kind, extra = {}) => ({ kind, title: 'Page views peaked Wednesday at 1,840', rows: days, unit: 'views', ...extra });

test('every chart kind produces SVG the validator accepts', () => {
  for (const kind of ['bar', 'hbar', 'line']) {
    const svg = renderChart(spec(kind, { subtitle: 'sample week', reference: { value: 1500, label: 'target' } }));
    assert.deepEqual(validateSvg(svg), [], kind);
  }
});

test('values come from the rows; the peak is the accent', () => {
  const svg = renderChart(spec('bar'));
  assert.match(svg, /1,840/);
  assert.equal(svg.match(/fill="var\(--cds-chart-categorical-1\)"/g).length, 1);
  assert.match(svg, /<title>Wed: 1,840 views<\/title>/);
  assert.match(renderChart(spec('bar', { highlight: 'Fri' })), /Fri: 1,320 views<\/title>/);
});

test('bars are measured from zero: the 1,200 bar is 1200/1840 of the tallest', () => {
  const svg = renderChart(spec('bar'));
  const heights = [...svg.matchAll(/<rect [^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(Math.abs(heights[0] / heights[2] - 1200 / 1840) < 0.001);
});

test('text from the caller is escaped', () => {
  const svg = renderChart(spec('bar', { title: 'A & <B> "C"' }));
  assert.match(svg, /A &amp; &lt;B&gt; &quot;C&quot;/);
  assert.deepEqual(validateSvg(svg), []);
});

test('bad input is refused with a reason', () => {
  assert.throws(() => renderChart(spec('bar', { highlight: 'Sun' })), /not one of the row labels/);
  assert.throws(() => renderChart(spec('bar', { rows: [{ x: 'a', y: -1 }] })), /cannot be negative/);
  assert.throws(() => renderChart(spec('bar', { rows: days.map((r) => ({ ...r, x: 'a very long category label' })) })), /too long/);
  assert.doesNotThrow(() => renderChart(spec('line', { rows: [{ x: 'a', y: -1 }, { x: 'b', y: 4 }] })));
});

test('create_chart places it; update_chart redraws from the stored rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charts-'));
  const store = new Store(dir);
  const tools = Object.fromEntries(makeTools(store, 'http://x', '').map((t) => [t.name, t.call]));
  const doc = JSON.parse(tools.create_doc({ title: 'Views', sections: ['Chart: views by day'] }));
  const made = JSON.parse(tools.create_chart({ id: doc.id, ...spec('bar'), source: 'typed in chat · 5 days', target: doc.blocks[2].id, markdown: '## Views\n\n{{embed}}\n\nPeak midweek.' }));
  assert.deepEqual(made.blocks.slice(-3).map((b) => b.type), ['md', 'embed', 'md']);
  assert.equal(made.blocks.at(-2).caption, 'typed in chat · 5 days');

  const fixed = days.map((r) => (r.x === 'Mon' ? { ...r, y: 2000 } : r));
  JSON.parse(tools.update_chart({ id: doc.id, widget: made.widget, rows: fixed, title: 'Page views peaked Monday at 2,000' }));
  const read = JSON.parse(tools.read_widget({ id: doc.id, widget: made.widget }));
  assert.match(read.svg, /Mon: 2,000 views/);
  assert.equal(read.chart.title, 'Page views peaked Monday at 2,000');
  assert.equal(read.chart.unit, 'views');

  const hand = JSON.parse(tools.create_widget({ id: doc.id, caption: 'x', svg: '<svg viewBox="0 0 760 40" role="img" aria-label="x"><text x="1" y="20" fill="var(--cds-text-primary)">x</text></svg>' }));
  assert.throws(() => tools.update_chart({ id: doc.id, widget: hand.widget, title: 'y' }), /not made by create_chart/);
  fs.rmSync(dir, { recursive: true });
});
