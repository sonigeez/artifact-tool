import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Store, ToolError, blockHash, titleOf } from './store.js';
import { makeTools, exportMarkdown } from './tools.js';
import { renderBlock } from './render.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = {
  '/app.css': ['app.css', 'text/css'],
  '/doc.js': ['doc.js', 'text/javascript'],
};

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8` });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5_000_000) throw new ToolError('too_large', 'request body over 5 MB');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
}

const docView = (doc) => ({
  id: doc.id,
  title: titleOf(doc),
  rev: doc.rev,
  blocks: doc.blocks.map((b) => ({ ...b, h: blockHash(b), html: renderBlock(b, doc) })),
});

export function start({ port = 3000, host = '127.0.0.1', dataDir = 'data', token = '', author = '', publicUrl } = {}) {
  const store = new Store(dataDir);
  let baseUrl = publicUrl;
  const withBase = () => makeTools(store, baseUrl, author);

  const authorized = (req) => {
    if (!token) return true;
    const given = Buffer.from(req.headers.authorization ?? '');
    const want = Buffer.from(`Bearer ${token}`);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  };

  async function handleMcp(req, res) {
    const server = new McpServer({ name: 'artifact-tool', version: '0.1.0' });
    for (const t of withBase()) {
      server.registerTool(t.name, { description: t.description, inputSchema: t.schema }, async (args) => {
        try {
          return { content: [{ type: 'text', text: t.call(args) }] };
        } catch (e) {
          return { isError: true, content: [{ type: 'text', text: `${e.code ?? 'error'}: ${e.message}` }] };
        }
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, await readJson(req));
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (p === '/mcp' || p.startsWith('/api/tools/')) {
      if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
      if (p === '/mcp') return handleMcp(req, res);
      const tool = withBase().find((t) => t.name === p.slice('/api/tools/'.length));
      if (!tool || req.method !== 'POST') return send(res, 404, { error: 'unknown tool' });
      return send(res, 200, { result: tool.call(await readJson(req)) });
    }

    if (STATIC[p]) {
      const [file, type] = STATIC[p];
      return send(res, 200, fs.readFileSync(path.join(publicDir, file), 'utf8'), type);
    }
    if (p.startsWith('/d/')) return send(res, 200, fs.readFileSync(path.join(publicDir, 'doc.html'), 'utf8'), 'text/html');

    const m = p.match(/^\/api\/docs\/([\w-]+)(?:\/(events|export\.md))?$/);
    if (!m) return void res.writeHead(404).end();
    const [, id, sub] = m;

    if (sub === 'events') {
      store.get(id);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(':ok\n\n');
      const onChange = (changed, rev) => changed === id && res.write(`data: ${JSON.stringify({ rev })}\n\n`);
      const beat = setInterval(() => res.write(':\n\n'), 25_000);
      store.on('change', onChange);
      req.on('close', () => {
        clearInterval(beat);
        store.off('change', onChange);
      });
      return;
    }
    if (sub === 'export.md') return send(res, 200, exportMarkdown(store.get(id)), 'text/markdown');
    return send(res, 200, docView(store.get(id)));
  }

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (e) {
      const status = e instanceof ToolError ? (e.code.endsWith('_not_found') ? 404 : e.code === 'guard_mismatch' ? 409 : 400) : e instanceof SyntaxError ? 400 : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: e.message, code: e.code });
      else res.end();
    }
  });

  return new Promise((resolve) =>
    server.listen(port, host, () => {
      baseUrl ??= `http://${host}:${server.address().port}`;
      resolve({ server, store, baseUrl });
    }),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { baseUrl } = await start({
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? '127.0.0.1',
    dataDir: process.env.DATA_DIR ?? 'data',
    token: process.env.DOCS_TOKEN ?? '',
    author: process.env.DOCS_AUTHOR ?? '',
    publicUrl: process.env.PUBLIC_URL,
  });
  console.log(`artifact-tool listening on ${baseUrl}\nMCP endpoint: ${baseUrl}/mcp`);
}
