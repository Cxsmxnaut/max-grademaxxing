import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, mdEscape } from '../public/markdown.js';

// ── inline emphasis ─────────────────────────────────────────────────────

test('bold renders as <strong>', () => {
  assert.equal(renderMarkdown('you **crushed** that'), '<p>you <strong>crushed</strong> that</p>');
  assert.equal(renderMarkdown('**bold text**'), '<p><strong>bold text</strong></p>');
});

test('italic renders as <em> (asterisk and underscore forms)', () => {
  assert.equal(renderMarkdown('just *checking* here'), '<p>just <em>checking</em> here</p>');
  assert.equal(renderMarkdown('just _checking_ here'), '<p>just <em>checking</em> here</p>');
});

test('bold+italic and strike render', () => {
  assert.equal(renderMarkdown('***both*** here'), '<p><strong><em>both</em></strong> here</p>');
  assert.equal(renderMarkdown('~~gone~~'), '<p><del>gone</del></p>');
});

test('math with bare asterisks stays literal', () => {
  assert.equal(renderMarkdown('do 5 * 3 * 2 first'), '<p>do 5 * 3 * 2 first</p>');
});

// ── code ────────────────────────────────────────────────────────────────

test('inline code is rendered and protected from emphasis', () => {
  assert.equal(renderMarkdown('run `x**y` now'), '<p>run <code>x**y</code> now</p>');
  assert.equal(renderMarkdown('run `a*b*c` now'), '<p>run <code>a*b*c</code> now</p>');
});

test('fenced code blocks become standalone <pre>, escaping contents', () => {
  assert.equal(
    renderMarkdown('text\n```\ncode1\ncode2\n```\nafter'),
    '<p>text</p><pre><code>code1\ncode2</code></pre><p>after</p>'
  );
  assert.equal(
    renderMarkdown('```\n<script>x</script>\n```'),
    '<pre><code>&lt;script&gt;x&lt;/script&gt;</code></pre>'
  );
});

// ── block structure ─────────────────────────────────────────────────────

test('ul and ol lists render with emphasis inside items', () => {
  assert.equal(renderMarkdown('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(renderMarkdown('1. first\n2. second'), '<ol><li>first</li><li>second</li></ol>');
  assert.equal(renderMarkdown('- the **final** matters'), '<ul><li>the <strong>final</strong> matters</li></ul>');
});

test('headings render as <h3>', () => {
  assert.equal(renderMarkdown('### The plan'), '<h3>The plan</h3>');
});

test('single newline becomes <br>, blank line separates paragraphs', () => {
  assert.equal(renderMarkdown('line one\nline two'), '<p>line one<br>line two</p>');
  assert.equal(renderMarkdown('para one\n\npara two'), '<p>para one</p><p>para two</p>');
});

test('empty string renders to empty string', () => {
  assert.equal(renderMarkdown(''), '');
});

// ── safety: model output can never inject HTML ──────────────────────────

test('script tags are escaped, never executed markup', () => {
  assert.equal(renderMarkdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('event-handler attributes are escaped', () => {
  assert.equal(renderMarkdown('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
});

test('HTML inside emphasis is escaped too', () => {
  assert.equal(renderMarkdown('**<b>nope</b>**'), '<p><strong>&lt;b&gt;nope&lt;/b&gt;</strong></p>');
});

test('mdEscape covers the four dangerous characters', () => {
  assert.equal(mdEscape('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
});

// ── realistic Max reply ─────────────────────────────────────────────────

test('realistic reply: heading + bold + code + list in one pass', () => {
  const html = renderMarkdown('### Plan\n\n1. **Organize** notes using `recall`\n2. **Practice** weak spots\n\nDone.');
  assert.ok(html.includes('<h3>Plan</h3>'));
  assert.ok(html.includes('<strong>Organize</strong>'));
  assert.ok(html.includes('<code>recall</code>'));
  assert.ok(html.includes('<ol><li>'));
  assert.ok(html.includes('<p>Done.</p>'));
  assert.ok(!html.includes('**'));
});

test('markdown tables render as <div class="table-wrap"><table> with <thead> and <tbody>', () => {
  const md = [
    '| Scenario | HW Avg | Final Needed |',
    '| :--- | :---: | ---: |',
    '| **25/25 HW** | 91% | **93.5%** |',
    '| **20/25 HW** | 86% | 105.4% |',
  ].join('\n');
  const html = renderMarkdown(md);
  assert.ok(html.includes('<div class="table-wrap"><table>'));
  assert.ok(html.includes('<th>Scenario</th>'));
  assert.ok(html.includes('<td><strong>25/25 HW</strong></td>'));
  assert.ok(html.includes('<td><strong>93.5%</strong></td>'));
});

test('blockquotes and horizontal rules render cleanly', () => {
  const html = renderMarkdown('--- \n\n> **Bottom Line:** Aim for a 94% on the final.');
  assert.ok(html.includes('<hr>'));
  assert.ok(html.includes('<blockquote><p><strong>Bottom Line:</strong> Aim for a 94% on the final.</p></blockquote>'));
});

test('LaTeX display and inline math delimiters are cleaned into readable math', () => {
  const html = renderMarkdown('Solve $$0.30x \\ge 28.05$$ which gives $x \\ge \\frac{28.05}{0.30}$.');
  assert.ok(!html.includes('$$'));
  assert.ok(!html.includes('\\ge'));
  assert.ok(!html.includes('\\frac'));
  assert.ok(html.includes('≥'));
  assert.ok(html.includes('(28.05) / (0.30)'));
});
