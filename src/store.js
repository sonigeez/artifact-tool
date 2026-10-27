import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { marked } from 'marked';
import { validateSvg } from './widget.js';

export class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const newId = () => crypto.randomBytes(5).toString('hex');
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);

// A "block" is one top-level markdown element (heading, paragraph, list, table, code).
const splitMarkdown = (md) =>
  marked.lexer(String(md)).filter((t) => t.type !== 'space').map((t) => t.raw.trim()).filter(Boolean);

export const blockHash = (b) =>
  sha(b.type + (b.text ?? b.intent ?? `${b.widget}|${b.caption}`));

export const titleOf = (doc) =>
  doc.blocks.find((b) => b.type === 'md' && /^# /.test(b.text))?.text.slice(2).split('\n')[0] ?? doc.title;

const mdBlocks = (markdown, rev) =>
  splitMarkdown(markdown).map((text) => ({ id: newId(), type: 'md', text, rev }));

function indexOf(doc, target) {
  const i = doc.blocks.findIndex((b) => b.id === target);
  if (i < 0) throw new ToolError('block_not_found', `no block with id "${target}"; read the doc for current ids`);
  return i;
}

// Replacing or deleting existing content needs the hash the caller last saw, so an
// edit made by someone else in between is never silently overwritten.
function checkGuard(block, op) {
  if (block.type === 'pending' || op.force) return;
  if (!op.ifHash) throw new ToolError('missing_guard', `${op.op} of block ${block.id} needs ifHash (its "h" from read_doc)`);
  if (op.ifHash !== blockHash(block)) {
    throw new ToolError('guard_mismatch', `block ${block.id} changed since you read it (now h=${blockHash(block)}); re-read and keep their edit`);
  }
}

function applyOp(doc, op, rev) {
  switch (op.op) {
    case 'replace': {
      const i = indexOf(doc, op.target);
      checkGuard(doc.blocks[i], op);
      const blocks = mdBlocks(op.markdown ?? '', rev);
      if (!blocks.length) throw new ToolError('bad_request', 'replace needs non-empty markdown');
      doc.blocks.splice(i, 1, ...blocks);
      return;
    }
    case 'insert': {
      const blocks = mdBlocks(op.markdown ?? '', rev);
      if (!blocks.length) throw new ToolError('bad_request', 'insert needs non-empty markdown');
      if (op.side === 'end') return void doc.blocks.push(...blocks);
      const i = indexOf(doc, op.target);
      doc.blocks.splice(op.side === 'before' ? i : i + 1, 0, ...blocks);
      return;
    }
    case 'delete': {
      const i = indexOf(doc, op.target);
      checkGuard(doc.blocks[i], op);
      doc.blocks.splice(i, 1);
      return;
    }
    case 'text': {
      if (!op.find) throw new ToolError('bad_request', 'text op needs find');
      const hits = doc.blocks.filter((b) => b.type === 'md' && b.text.includes(op.find));
      const count = hits.reduce((n, b) => n + b.text.split(op.find).length - 1, 0);
      if (count === 0) throw new ToolError('find_none', `"${op.find}" not found; quote the words as they stand now`);
      if (count > 1) throw new ToolError('find_ambiguous', `"${op.find}" occurs ${count} times; quote a longer phrase`);
      hits[0].text = hits[0].text.replace(op.find, () => op.with ?? '');
      hits[0].rev = rev;
      return;
    }
    default:
      throw new ToolError('bad_request', `unknown op "${op.op}"`);
  }
}

export class Store extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.docs = new Map();
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      this.docs.set(doc.id, doc);
    }
  }

  list() {
    return [...this.docs.values()]
      .map((d) => ({ id: d.id, title: titleOf(d), rev: d.rev, updatedAt: d.updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id) {
    const doc = this.docs.get(id);
    if (!doc) throw new ToolError('doc_not_found', `no doc with id "${id}"`);
    return doc;
  }

  create({ title, lead, sections, author }) {
    const now = new Date().toISOString();
    const byline = [now.slice(0, 10), author].filter(Boolean).join(' · ');
    const md = (text) => ({ id: newId(), type: 'md', text, rev: 1 });
    const doc = {
      id: crypto.randomUUID(),
      title,
      rev: 1,
      createdAt: now,
      updatedAt: now,
      blocks: [
        md(`# ${title}`),
        md(byline),
        ...(lead ? mdBlocks(lead, 1) : []),
        ...sections.map((intent) => ({ id: newId(), type: 'pending', intent, rev: 1 })),
      ],
      widgets: {},
    };
    this.save(doc);
    return doc;
  }

  // Runs fn on a copy; the doc only changes (and rev only advances) if fn succeeds.
  mutate(id, fn) {
    const draft = structuredClone(this.get(id));
    draft.rev += 1;
    draft.updatedAt = new Date().toISOString();
    const result = fn(draft, draft.rev);
    this.save(draft);
    return { doc: draft, result };
  }

  update(id, ops) {
    return this.mutate(id, (doc, rev) => ops.forEach((op) => applyOp(doc, op, rev))).doc;
  }

  addWidget(id, { svg, caption, target, markdown, chart }) {
    const errors = validateSvg(svg);
    if (errors.length) throw new ToolError('widget_invalid', `svg refused:\n- ${errors.join('\n- ')}`);
    if (markdown !== undefined && !/^\{\{embed\}\}\s*$/m.test(markdown)) {
      throw new ToolError('bad_request', 'markdown must contain a line {{embed}} where the drawing goes');
    }
    return this.mutate(id, (doc, rev) => {
      const widget = newId();
      doc.widgets[widget] = { id: widget, svg, pub: 1, chart };
      const [before, after = ''] = (markdown ?? '{{embed}}').split(/^\{\{embed\}\}\s*$/m);
      const blocks = [
        ...mdBlocks(before, rev),
        { id: newId(), type: 'embed', widget, caption, rev },
        ...mdBlocks(after, rev),
      ];
      if (target === undefined) doc.blocks.push(...blocks);
      else {
        const i = indexOf(doc, target);
        doc.blocks.splice(doc.blocks[i].type === 'pending' ? i : i + 1, doc.blocks[i].type === 'pending' ? 1 : 0, ...blocks);
      }
      return widget;
    });
  }

  updateWidget(id, widget, svg, chart) {
    const errors = validateSvg(svg);
    if (errors.length) throw new ToolError('widget_invalid', `svg refused:\n- ${errors.join('\n- ')}`);
    return this.mutate(id, (doc, rev) => {
      const w = doc.widgets[widget];
      if (!w) throw new ToolError('widget_not_found', `no widget "${widget}" in this doc`);
      w.svg = svg;
      w.pub += 1;
      if (chart) w.chart = chart;
      for (const b of doc.blocks) if (b.widget === widget) b.rev = rev;
    }).doc;
  }

  save(doc) {
    const file = path.join(this.dir, `${doc.id}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(doc));
    fs.renameSync(`${file}.tmp`, file);
    this.docs.set(doc.id, doc);
    this.emit('change', doc.id, doc.rev);
  }
}
