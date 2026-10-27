import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from '../src/server.js';
import { validateSvg } from '../src/widget.js';

const SVG = `<svg viewBox="0 0 760 100" role="img" aria-label="Only green builds ship" font-size="13"><text x="24" y="30" font-size="15" fill="var(--cds-text-primary)">Only green builds ship</text><rect x="24" y="48" width="120" height="40" rx="8" fill="none" stroke="var(--cds-chart-axis)"/></svg>`;

let app, dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-'));
  app = await start({ port: 0, dataDir: dir, token: 'secret' });
});
after(() => {
  app.server.close();
  fs.rmSync(dir, { recursive: true });
});

const call = async (name, args, token = 'secret') => {
  const res = await fetch(`${app.baseUrl}/api/tools/${name}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  const body = await res.json();
  return { status: res.status, ...body, result: body.result && (name === 'guide' || name === 'export_doc' ? body.result : JSON.parse(body.result)) };
};

test('tools require the token', async () => {
  assert.equal((await call('list_docs', {}, 'wrong')).status, 401);
});

test('create → fill → guard → widget → export', async () => {
  const created = (await call('create_doc', { title: 'Why builds fail', sections: ['Causes: flaky tests', 'Flow: a drawing'] })).result;
  const [, , pendingA, pendingB] = created.blocks;
  assert.equal(pendingA.type, 'pending');

  const filled = (await call('update_doc', { id: created.id, ops: [{ op: 'replace', target: pendingA.id, markdown: '## Causes\n\nFlaky tests.\n\n| a | b |\n|---|---|\n| 1 | 2 |' }] })).result;
  assert.equal(filled.rev, 2);
  const heading = filled.blocks.find((b) => b.text === '## Causes');

  // replacing content without a guard is refused; a stale guard is refused; nothing changed
  assert.equal((await call('update_doc', { id: created.id, ops: [{ op: 'delete', target: heading.id }] })).error.includes('ifHash'), true);
  const stale = await call('update_doc', { id: created.id, ops: [{ op: 'replace', target: heading.id, markdown: '## X', ifHash: 'deadbeef' }] });
  assert.equal(stale.status, 409);
  assert.equal((await call('read_doc', { id: created.id })).result.rev, 2);

  // a first edit succeeds and replaces the block, so the old id/hash no longer applies
  await call('update_doc', { id: created.id, ops: [{ op: 'replace', target: heading.id, markdown: '## Real causes', ifHash: heading.h }] });
  const after = await call('update_doc', { id: created.id, ops: [{ op: 'replace', target: heading.id, markdown: '## Agent', ifHash: heading.h }] });
  assert.equal(after.status, 404);

  // widgets: invalid svg is refused with reasons; valid replaces the pending block
  const bad = await call('create_widget', { id: created.id, svg: '<svg><script/></svg>', caption: 'x' });
  assert.match(bad.error, /viewBox/);
  const withWidget = (await call('create_widget', { id: created.id, svg: SVG, caption: 'build flow', target: pendingB.id, markdown: '## Flow\n\n{{embed}}\n\nGreen ships.' })).result;
  assert.deepEqual(withWidget.blocks.slice(-3).map((b) => b.type), ['md', 'embed', 'md']);

  const html = await (await fetch(`${app.baseUrl}/api/docs/${created.id}`)).json();
  assert.match(html.blocks.find((b) => b.type === 'embed').html, /<figure><svg/);
  assert.match(html.blocks.find((b) => b.text === '## Real causes').html, /<h2>Real causes<\/h2>/);

  const md = (await call('export_doc', { id: created.id })).result;
  assert.match(md, /^# Why builds fail/);
  assert.match(md, /Green ships\./);
});

test('failed ops leave the doc untouched', async () => {
  const doc = (await call('create_doc', { title: 'Atomic', sections: ['One'] })).result;
  const r = await call('update_doc', {
    id: doc.id,
    ops: [{ op: 'insert', side: 'end', markdown: 'added' }, { op: 'text', find: 'nope', with: 'x' }],
  });
  assert.match(r.error, /not found/);
  assert.equal((await call('read_doc', { id: doc.id })).result.rev, 1);
});

test('raw HTML and javascript links are neutralised', async () => {
  const doc = (await call('create_doc', { title: 'XSS', lead: '<img src=x onerror=alert(1)>', sections: [] })).result;
  await call('update_doc', { id: doc.id, ops: [{ op: 'insert', side: 'end', markdown: '[a](javascript:alert(1))' }] });
  const view = await (await fetch(`${app.baseUrl}/api/docs/${doc.id}`)).json();
  const all = view.blocks.map((b) => b.html).join('');
  assert.doesNotMatch(all, /<img|javascript:/);
});

test('MCP endpoint lists and calls tools', async () => {
  const headers = { authorization: 'Bearer secret', 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const rpc = async (method, params, id = 1) => {
    const res = await fetch(`${app.baseUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    const text = await res.text();
    return JSON.parse(text.includes('data:') ? text.match(/data: (.*)/)[1] : text);
  };
  const list = await rpc('tools/list', {});
  assert.ok(list.result.tools.some((t) => t.name === 'create_widget'));
  const out = await rpc('tools/call', { name: 'create_doc', arguments: { title: 'Via MCP', sections: ['A'] } });
  assert.match(out.result.content[0].text, /\/d\//);
});

test('svg validator', () => {
  assert.deepEqual(validateSvg(SVG), []);
  const errs = validateSvg(SVG.replace('var(--cds-text-primary)', '#000').replace('<rect', '<image href="x"/><rect'));
  assert.ok(errs.some((e) => e.includes('theme token')));
  assert.ok(errs.some((e) => e.includes('<image>')));
  assert.ok(errs.some((e) => e.includes('href')));
});
