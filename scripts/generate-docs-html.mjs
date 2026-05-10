import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const docsDir = path.join(rootDir, 'docs');

const documents = [
  { source: 'README.md', output: 'index.html', title: 'VirtualWebCam 文档中心' },
  { source: 'development-guide.md', output: 'development-guide.html', title: 'VirtualWebCam 开发技术文档' },
  { source: 'deployment-ops-guide.md', output: 'deployment-ops-guide.html', title: 'VirtualWebCam 部署运维文档' },
  { source: 'user-guide.md', output: 'user-guide.html', title: 'VirtualWebCam 用户使用指南' },
];

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

function inlineMarkdown(value) {
  let html = escapeHtml(value);

  const codes = [];
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    const marker = `@@CODE${codes.length}@@`;
    codes.push(`<code>${code}</code>`);
    return marker;
  });

  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  codes.forEach((code, index) => {
    html = html.replace(`@@CODE${index}@@`, code);
  });

  return html;
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function renderTable(lines, startIndex) {
  const header = splitTableRow(lines[startIndex]);
  const rows = [];
  let index = startIndex + 2;

  while (index < lines.length && /^\s*\|/.test(lines[index])) {
    rows.push(splitTableRow(lines[index]));
    index += 1;
  }

  const thead = `<thead><tr>${header.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead>`;
  const tbody = `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody>`;

  return {
    html: `<table>${thead}${tbody}</table>`,
    nextIndex: index,
  };
}

function markdownToHtml(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  const headings = [];
  let index = 0;
  let inCode = false;
  let codeLang = '';
  let codeLines = [];
  let listType = null;

  function closeList() {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  }

  while (index < lines.length) {
    const line = lines[index];

    if (inCode) {
      if (line.startsWith('```')) {
        html.push(`<pre><code class="language-${escapeHtml(codeLang)}">${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        inCode = false;
        codeLang = '';
        codeLines = [];
      } else {
        codeLines.push(line);
      }
      index += 1;
      continue;
    }

    if (line.startsWith('```')) {
      closeList();
      inCode = true;
      codeLang = line.slice(3).trim();
      index += 1;
      continue;
    }

    if (!line.trim()) {
      closeList();
      index += 1;
      continue;
    }

    if (index + 1 < lines.length && /^\s*\|/.test(line) && isTableSeparator(lines[index + 1])) {
      closeList();
      const table = renderTable(lines, index);
      html.push(table.html);
      index = table.nextIndex;
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      const idBase = slugify(text);
      const same = headings.filter((heading) => heading.id === idBase || heading.id.startsWith(`${idBase}-`)).length;
      const id = same ? `${idBase}-${same + 1}` : idBase;
      headings.push({ level, text, id });
      html.push(`<h${level} id="${id}"><a class="anchor" href="#${id}">#</a>${inlineMarkdown(text)}</h${level}>`);
      index += 1;
      continue;
    }

    const unorderedMatch = /^\s*[-*]\s+(.+)$/.exec(line);
    if (unorderedMatch) {
      if (listType !== 'ul') {
        closeList();
        listType = 'ul';
        html.push('<ul>');
      }
      html.push(`<li>${inlineMarkdown(unorderedMatch[1])}</li>`);
      index += 1;
      continue;
    }

    const orderedMatch = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (orderedMatch) {
      if (listType !== 'ol') {
        closeList();
        listType = 'ol';
        html.push('<ol>');
      }
      html.push(`<li>${inlineMarkdown(orderedMatch[1])}</li>`);
      index += 1;
      continue;
    }

    const quoteMatch = /^\s*>\s+(.+)$/.exec(line);
    if (quoteMatch) {
      closeList();
      html.push(`<blockquote>${inlineMarkdown(quoteMatch[1])}</blockquote>`);
      index += 1;
      continue;
    }

    closeList();
    const paragraph = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].startsWith('```') &&
      !/^(#{1,6})\s+/.test(lines[index]) &&
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !/^\s*\d+\.\s+/.test(lines[index]) &&
      !(index + 1 < lines.length && /^\s*\|/.test(lines[index]) && isTableSeparator(lines[index + 1]))
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    html.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
  }

  closeList();

  const toc = headings
    .filter((heading) => heading.level <= 3)
    .map((heading) => `<a class="toc-level-${heading.level}" href="#${heading.id}">${escapeHtml(heading.text)}</a>`)
    .join('');

  return {
    body: html.join('\n'),
    toc,
  };
}

function renderPage({ title, markdown, currentOutput }) {
  const rendered = markdownToHtml(markdown);
  const nav = documents
    .map((doc) => {
      const active = doc.output === currentOutput ? ' aria-current="page"' : '';
      return `<a${active} href="./${doc.output}">${escapeHtml(doc.title.replace('VirtualWebCam ', ''))}</a>`;
    })
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7fb;
      --paper: #ffffff;
      --text: #172033;
      --muted: #5d6b82;
      --line: #dce3ee;
      --brand: #155eef;
      --brand-soft: #eaf1ff;
      --code-bg: #0f172a;
      --code-text: #dbeafe;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(circle at 0 0, #eaf6ff 0, transparent 30rem), var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      line-height: 1.72;
    }
    a { color: var(--brand); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .shell {
      display: grid;
      grid-template-columns: 18rem minmax(0, 1fr);
      gap: 1.5rem;
      max-width: 1440px;
      margin: 0 auto;
      padding: 2rem;
    }
    .sidebar {
      position: sticky;
      top: 1.5rem;
      align-self: start;
      max-height: calc(100vh - 3rem);
      overflow: auto;
      padding: 1rem;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.86);
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.06);
    }
    .brand {
      margin: 0 0 0.75rem;
      font-size: 1.15rem;
      font-weight: 800;
    }
    .nav {
      display: grid;
      gap: 0.35rem;
      margin-bottom: 1rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--line);
    }
    .nav a, .toc a {
      display: block;
      border-radius: 8px;
      padding: 0.42rem 0.55rem;
      color: var(--muted);
    }
    .nav a[aria-current="page"] {
      color: var(--brand);
      background: var(--brand-soft);
      font-weight: 700;
    }
    .toc-title {
      margin: 0 0 0.4rem;
      color: var(--muted);
      font-size: 0.82rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .toc {
      display: grid;
      gap: 0.1rem;
      font-size: 0.92rem;
    }
    .toc-level-2 { padding-left: 1rem !important; }
    .toc-level-3 { padding-left: 2rem !important; font-size: 0.86rem; }
    main {
      min-width: 0;
      padding: 2rem 2.25rem;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: var(--paper);
      box-shadow: 0 20px 50px rgba(15, 23, 42, 0.08);
    }
    h1, h2, h3, h4, h5, h6 {
      line-height: 1.3;
      margin: 1.8em 0 0.65em;
    }
    h1 { margin-top: 0; font-size: 2.15rem; }
    h2 { padding-top: 0.5rem; border-top: 1px solid var(--line); font-size: 1.55rem; }
    h3 { font-size: 1.22rem; }
    p, ul, ol, table, pre, blockquote { margin: 0.8rem 0; }
    ul, ol { padding-left: 1.4rem; }
    li + li { margin-top: 0.25rem; }
    code {
      border-radius: 5px;
      padding: 0.12rem 0.32rem;
      background: #eef2f7;
      color: #0f3b74;
      font-family: "SFMono-Regular", Consolas, monospace;
      font-size: 0.92em;
    }
    pre {
      overflow: auto;
      border-radius: 12px;
      padding: 1rem;
      background: var(--code-bg);
      color: var(--code-text);
    }
    pre code {
      padding: 0;
      background: transparent;
      color: inherit;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 10px;
      font-size: 0.95rem;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 0.58rem 0.7rem;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: #f2f6fb;
      color: #27364f;
      font-weight: 700;
    }
    tr:last-child td { border-bottom: 0; }
    blockquote {
      border-left: 4px solid var(--brand);
      padding: 0.4rem 0 0.4rem 1rem;
      color: var(--muted);
      background: #f8fbff;
    }
    .anchor {
      opacity: 0;
      margin-right: 0.35rem;
      font-weight: 600;
    }
    h1:hover .anchor, h2:hover .anchor, h3:hover .anchor, h4:hover .anchor {
      opacity: 1;
      text-decoration: none;
    }
    @media (max-width: 960px) {
      .shell { display: block; padding: 1rem; }
      .sidebar { position: static; max-height: none; margin-bottom: 1rem; }
      main { padding: 1.2rem; }
      h1 { font-size: 1.7rem; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <p class="brand">VirtualWebCam</p>
      <nav class="nav">${nav}</nav>
      <p class="toc-title">目录</p>
      <nav class="toc">${rendered.toc}</nav>
    </aside>
    <main>${rendered.body}</main>
  </div>
</body>
</html>
`;
}

for (const doc of documents) {
  const sourcePath = path.join(docsDir, doc.source);
  const outputPath = path.join(docsDir, doc.output);
  const markdown = fs.readFileSync(sourcePath, 'utf8');
  const html = renderPage({
    title: doc.title,
    markdown,
    currentOutput: doc.output,
  });
  fs.writeFileSync(outputPath, html);
  console.log(`generated ${path.relative(rootDir, outputPath)}`);
}

