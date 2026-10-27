const id = location.pathname.split('/').pop();
const root = document.getElementById('doc');
const toc = document.getElementById('toc');
const els = new Map(); // block id → { el, rev }
let headings = [];
let shownRev = 0;

function blockEl(b) {
  const el = document.createElement('div');
  el.className = `block ${b.type}`;
  if (b.type === 'pending') {
    el.innerHTML = '<span class="skel"></span><span class="skel short"></span>';
    const intent = document.createElement('small');
    intent.textContent = b.intent;
    el.append(intent);
  } else el.innerHTML = b.html; // server-rendered: raw HTML escaped, links filtered, SVG validated
  return el;
}

// Only blocks whose revision changed are rebuilt, so the page never jumps or flashes.
function sync(blocks, animate) {
  const seen = new Set();
  let prev = null;
  for (const b of blocks) {
    seen.add(b.id);
    let ent = els.get(b.id);
    if (!ent || ent.rev !== b.rev) {
      const el = blockEl(b);
      if (animate) el.classList.add('fresh');
      ent?.el.remove();
      ent = { el, rev: b.rev };
      els.set(b.id, ent);
    }
    const want = prev ? prev.nextSibling : root.firstChild;
    if (ent.el !== want) root.insertBefore(ent.el, want);
    prev = ent.el;
  }
  for (const [bid, ent] of els) {
    if (!seen.has(bid)) {
      ent.el.remove();
      els.delete(bid);
    }
  }
}

function decorate() {
  root.querySelectorAll('.byline, .lead').forEach((el) => el.classList.remove('byline', 'lead'));
  root.children[1]?.classList.add('byline');
  const lead = root.children[2];
  if (lead?.firstElementChild?.tagName === 'P') lead.classList.add('lead');
  const byline = root.querySelector('.byline p');
  if (byline) chips(byline);

  headings = [...root.querySelectorAll('h2')];
  headings.forEach((h, i) => (h.id = `s${i}`));
  toc.replaceChildren(
    ...headings.map((h) => {
      const a = document.createElement('a');
      a.href = `#${h.id}`;
      a.textContent = h.textContent;
      return a;
    }),
  );
  onScroll();
}

function onScroll() {
  const current = headings.filter((h) => h.getBoundingClientRect().top < 120).at(-1);
  for (const a of toc.children) a.classList.toggle('on', a.hash === `#${current?.id}`);
}

// "2026-10-27 · Name" becomes a calendar chip reading "Oct 27, 2026" and an "@Name" chip.
function chips(p) {
  const m = p.querySelector('.chip') ? null : p.textContent.match(/^(\d{4})-(\d{2})-(\d{2})(.*)$/);
  if (!m) return;
  const [, y, mo, d, rest] = m;
  const date = document.createElement('span');
  date.className = 'chip';
  date.innerHTML = '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><rect x="2" y="3.5" width="14" height="12.5" rx="2.5"/><path d="M2 7.5h14M6 2v3M12 2v3"/></svg>';
  date.append(new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }));
  const parts = [date];
  const author = rest.replace(/^\s*·?\s*/, '');
  if (author) {
    const who = document.createElement('span');
    who.className = 'chip';
    who.textContent = `@${author}`;
    parts.push('·', who);
  }
  p.replaceChildren(...parts);
}

async function load() {
  const res = await fetch(`/api/docs/${id}`);
  if (!res.ok) return void (root.textContent = 'Doc not found.');
  const doc = await res.json();
  if (doc.rev < shownRev) return; // a slower, older response lost the race
  const animate = shownRev > 0;
  shownRev = doc.rev;
  document.title = doc.title;
  sync(doc.blocks, animate);
  decorate();
}

addEventListener('scroll', onScroll, { passive: true });
new EventSource(`/api/docs/${id}/events`).onmessage = load;
load();
