# artifact-tool

> **Experiment: reverse engineering Claude's Docs.** This project is a hands-on study of how Claude's Docs
> feature appears to work, rebuilt from browser captures and the guidance Claude reported using (see
> [agent-docs-findings-engineering.md](agent-docs-findings-engineering.md) for what was observed and what is
> still unknown). It is an independent reimplementation of the observed workflow, not Anthropic's code, and is
> not affiliated with or endorsed by Anthropic.

Self-hosted living documents that AI agents write through tools. An agent creates an outline, fills one
section at a time while you watch, and draws diagrams and charts as validated SVG. The viewer is read-only;
agent edits are hash-guarded so concurrent agents never overwrite each other.

Design notes and the research behind it: [agent-docs-findings-engineering.md](agent-docs-findings-engineering.md).

## Run

```bash
npm install
npm start          # http://127.0.0.1:3000, data in ./data
npm test
```

| Env | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Listen address. Keep it on localhost unless a token or proxy protects it |
| `DATA_DIR` | `data` | One JSON file per doc |
| `DOCS_TOKEN` | unset | If set, `/mcp` and `/api/tools/*` need `Authorization: Bearer <token>` |
| `DOCS_AUTHOR` | unset | Shown in the byline next to the date |
| `PUBLIC_URL` | derived | Base for links returned to agents (set it behind a proxy) |

The viewer itself (reading docs) is **not** behind the token, so anyone who can reach it can read docs; put a reverse proxy with auth in
front of it if the host is reachable by others.

## Connect an agent

MCP (Streamable HTTP):

```bash
claude mcp add --transport http docs http://127.0.0.1:3000/mcp
# with DOCS_TOKEN set: --header "Authorization: Bearer <token>"
```

Plain HTTP for anything else: `POST /api/tools/<name>` with the tool's arguments as JSON.

| Tool | Purpose |
| --- | --- |
| `guide` | Authoring rules: `index`, `diagram`, `charts`, `editing`. Agents read this first |
| `create_doc` | Title, lead and one pending block per planned section; returns the link |
| `read_doc` | Block ids, hashes, revision; `since` returns only what changed |
| `update_doc` | Atomic `replace` / `insert` / `delete` / `text` ops with hash guards |
| `create_chart` / `update_chart` | Bar, horizontal-bar and line charts drawn by the server from data rows; the rows stay attached for later fixes |
| `create_widget` / `read_widget` / `update_widget` | Hand-drawn SVG diagrams and other chart forms, validated and placed in one call |
| `list_docs`, `export_doc` | Doc list and Markdown export |

## How it works

- A doc is an ordered list of blocks with stable ids: `md` (one heading, paragraph, list, table or code block),
  `pending` (a planned section) and `embed` (a drawing). Each block has a content hash.
- Replacing or deleting existing content needs the hash the agent last read. If another agent changed it meanwhile the call is
  refused with `guard_mismatch` and the newer text stands. A failed op batch changes nothing.
- Drawings are SVG with the root `viewBox="0 0 760 H"`, `role="img"`, an `aria-label`, an element allowlist, and
  colours only from `var(--cds-…)` tokens, so they work in light and dark. Violations are refused with reasons.
- Markdown is rendered server-side with raw HTML escaped and non-http(s) links dropped.

## Not built

Tabs, comments, @mentions/date chips, dropdown fields, file uploads, drawing label editing in place, and
rendered screenshots of drawings (they need a headless browser). The data model leaves room for each.
