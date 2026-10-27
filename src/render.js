import { Marked } from 'marked';

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const safeUrl = (u) => /^(https?:|mailto:|#|\/)/i.test(u ?? '');

// Raw HTML in agent markdown is shown as text, and unsafe link schemes are dropped.
const marked = new Marked({
  renderer: { html: ({ text }) => escapeHtml(text) },
  walkTokens(token) {
    if ((token.type === 'link' || token.type === 'image') && !safeUrl(token.href)) token.href = '#';
  },
});

export function renderBlock(block, doc) {
  if (block.type === 'md') {
    // Tables scroll sideways on narrow screens instead of squashing their columns.
    return marked.parse(block.text).replace(/<table>/g, '<div class="tablewrap"><table>').replace(/<\/table>/g, '</table></div>');
  }
  if (block.type === 'embed') {
    const svg = doc.widgets[block.widget]?.svg ?? '';
    return `<figure>${svg}<figcaption>${escapeHtml(block.caption)}</figcaption></figure>`;
  }
  return '';
}
