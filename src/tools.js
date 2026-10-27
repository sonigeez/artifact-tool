import { z } from 'zod';
import { ToolError, blockHash, titleOf } from './store.js';
import { GUIDES } from './guide.js';
import { renderChart } from './chart.js';

const outline = (doc, { full = false, since = 0 } = {}) =>
  doc.blocks
    .filter((b) => b.rev > since)
    .map((b) => {
      const text = b.text ?? b.intent ?? b.caption;
      return {
        id: b.id,
        type: b.type,
        h: blockHash(b),
        rev: b.rev,
        widget: b.widget,
        [b.type === 'pending' ? 'intent' : b.type === 'embed' ? 'caption' : 'text']: full || text.length <= 100 ? text : `${text.slice(0, 100)}…`,
      };
    });

const summary = (doc, baseUrl, extra = {}) => ({
  id: doc.id,
  url: `${baseUrl}/d/${doc.id}`,
  rev: doc.rev,
  blocks: outline(doc),
  ...extra,
});

const op = z.object({
  op: z.enum(['replace', 'insert', 'delete', 'text']),
  target: z.string().optional().describe('block id (replace, insert, delete)'),
  side: z.enum(['before', 'after', 'end']).optional().describe('insert position'),
  markdown: z.string().optional().describe('new content (replace, insert)'),
  ifHash: z.string().optional().describe('the block\'s h from read_doc (replace, delete of existing content)'),
  find: z.string().optional().describe('exact phrase (text op)'),
  with: z.string().optional().describe('replacement phrase (text op)'),
  force: z.boolean().optional().describe('overwrite without a hash guard; only when told to'),
});

const chartShape = {
  kind: z.enum(['bar', 'hbar', 'line']),
  title: z.string().min(1).describe('the finding with its number ("Page views peaked Wednesday at 1,840")'),
  subtitle: z.string().optional().describe('one quiet line: unit, period or scope'),
  rows: z.array(z.object({ x: z.string().min(1), y: z.number() })).min(1).max(60).describe('x = category or period label, y = value, in display order'),
  unit: z.string().optional().describe('unit for hover text, e.g. "views"'),
  highlight: z.string().optional().describe('x label to accent; default is the largest bar, or the last point of a line'),
  reference: z.object({ value: z.number(), label: z.string() }).optional().describe('a target, limit or previous level, drawn as a dashed line'),
};

export function makeTools(store, baseUrl, author) {
  const text = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return [
    {
      name: 'guide',
      description: 'Authoring rules. Call guide({topic:"index"}) before your first doc; "diagram", "charts" before drawing; "editing" before changing existing content.',
      schema: { topic: z.enum(Object.keys(GUIDES)) },
      run: ({ topic }) => GUIDES[topic],
    },
    {
      name: 'list_docs',
      description: 'List docs, most recently updated first.',
      schema: {},
      run: () => store.list().map((d) => ({ ...d, url: `${baseUrl}/d/${d.id}` })),
    },
    {
      name: 'create_doc',
      description: 'Create a doc skeleton: title, optional lead, and one pending block per planned section. Call this FIRST, before research, then give the user the url. A section that will hold a drawing should say so in its intent.',
      schema: {
        title: z.string().min(1).describe('states the finding'),
        lead: z.string().optional().describe('one or two sentences answering the ask'),
        sections: z.array(z.string()).describe('one intent per section, e.g. "Risks: what could slip and the fallback"'),
      },
      run: (a) => summary(store.create({ ...a, author }), baseUrl),
    },
    {
      name: 'read_doc',
      description: 'Outline of a doc: block ids, types, hashes, revision. full:true for complete text; since:N for only blocks changed after revision N.',
      schema: { id: z.string(), full: z.boolean().optional(), since: z.number().optional() },
      run: ({ id, full, since }) => {
        const doc = store.get(id);
        return { id, title: titleOf(doc), rev: doc.rev, blocks: outline(doc, { full, since }) };
      },
    },
    {
      name: 'update_doc',
      description: 'Apply edit ops atomically (see guide "editing"). Fill a section by replacing its pending block id with "## Heading" + body markdown.',
      schema: { id: z.string(), ops: z.array(op).min(1) },
      run: ({ id, ops }) => summary(store.update(id, ops), baseUrl),
    },
    {
      name: 'create_widget',
      description: 'Add a diagram or chart (validated SVG, see guides "diagram"/"charts") and place it in one step. target = pending block id to replace, or a block id to insert after; omit to append. markdown (with a {{embed}} line) supplies the section heading and text around the drawing.',
      schema: {
        id: z.string(),
        svg: z.string(),
        caption: z.string().describe('what the picture is of / data provenance'),
        target: z.string().optional(),
        markdown: z.string().optional(),
      },
      run: ({ id, ...a }) => {
        const { doc, result } = store.addWidget(id, a);
        return summary(doc, baseUrl, { widget: result });
      },
    },
    {
      name: 'create_chart',
      description: 'Draw a bar, hbar (horizontal bars, long labels or many rows) or line chart from data rows and place it, in one call. The server draws it from the rows (grey data, one blue highlight, values on the marks), so printed numbers always match your data. Read guide "charts" first. Other chart forms (waterfall, stacked, scatter) are drawn by hand with create_widget.',
      schema: {
        id: z.string(),
        ...chartShape,
        source: z.string().describe('where the numbers come from, shown under the chart ("orders.csv · 2025", "typed in chat · 5 days")'),
        target: z.string().optional().describe('pending block id to replace, or a block id to insert after; omit to append'),
        markdown: z.string().optional().describe('section heading and text around the chart; must contain a line {{embed}}'),
      },
      run: ({ id, source, target, markdown, ...spec }) => {
        const { doc, result } = store.addWidget(id, { svg: renderChart(spec), caption: source, target, markdown, chart: spec });
        return summary(doc, baseUrl, { widget: result });
      },
    },
    {
      name: 'update_chart',
      description: 'Change a chart made by create_chart: pass only the fields to change (e.g. corrected rows or a new title) and it is redrawn from the stored data.',
      schema: { id: z.string(), widget: z.string(), ...Object.fromEntries(Object.entries(chartShape).map(([k, v]) => [k, v.optional()])) },
      run: ({ id, widget, ...patch }) => {
        const old = store.get(id).widgets[widget];
        if (!old) throw new ToolError('widget_not_found', `no widget "${widget}" in this doc`);
        if (!old.chart) throw new ToolError('not_a_chart', 'this drawing was not made by create_chart; redraw it with update_widget');
        const spec = { ...old.chart, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
        return summary(store.updateWidget(id, widget, renderChart(spec), spec), baseUrl);
      },
    },
    {
      name: 'read_widget',
      description: 'Return a drawing\'s SVG source (and, for charts, the data it was drawn from).',
      schema: { id: z.string(), widget: z.string() },
      run: ({ id, widget }) => {
        const w = store.get(id).widgets[widget];
        if (!w) throw new ToolError('widget_not_found', `no widget "${widget}" in this doc`);
        return { svg: w.svg, chart: w.chart };
      },
    },
    {
      name: 'update_widget',
      description: 'Replace a drawing with a whole new SVG.',
      schema: { id: z.string(), widget: z.string(), svg: z.string() },
      run: ({ id, widget, svg }) => summary(store.updateWidget(id, widget, svg), baseUrl),
    },
    {
      name: 'export_doc',
      description: 'The doc as Markdown.',
      schema: { id: z.string() },
      run: ({ id }) => exportMarkdown(store.get(id)),
    },
  ].map((t) => ({ ...t, call: (args) => text(t.run(z.object(t.schema).parse(args ?? {}))) }));
}

export function exportMarkdown(doc) {
  return doc.blocks
    .map((b) => (b.type === 'md' ? b.text : b.type === 'embed' ? `*[${b.caption}: drawing, see the web version]*` : ''))
    .filter(Boolean)
    .join('\n\n');
}
