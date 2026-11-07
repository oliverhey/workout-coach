// Small, safe Markdown renderer (headings, bold/italic, code, lists, tables, hr, blockquote).
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+?)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
  return s;
}

function splitRow(line) {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0, -1);
  return l.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
}

export function md(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  let para = [];
  const flush = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { flush(); i++; continue; }
    // table
    if (t.startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const head = splitRow(t);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(splitRow(lines[i])); i++; }
      out.push('<div class="tbl"><table><thead><tr>' + head.map(h => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    let m;
    if ((m = t.match(/^(#{1,4})\s+(.*)$/))) { flush(); const n = m[1].length; out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); out.push('<hr>'); i++; continue; }
    if (t.startsWith('>')) { flush(); const q = []; while (i < lines.length && lines[i].trim().startsWith('>')) { q.push(lines[i].trim().replace(/^>\s?/, '')); i++; } out.push('<blockquote>' + q.map(inline).join('<br>') + '</blockquote>'); continue; }
    if (/^[-*•]\s+/.test(t)) { flush(); const items = []; while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) { items.push(lines[i].trim().replace(/^[-*•]\s+/, '')); i++; } out.push('<ul>' + items.map(x => `<li>${inline(x)}</li>`).join('') + '</ul>'); continue; }
    if (/^\d+[.)]\s+/.test(t)) { flush(); const items = []; while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].trim().replace(/^\d+[.)]\s+/, '')); i++; } out.push('<ol>' + items.map(x => `<li>${inline(x)}</li>`).join('') + '</ol>'); continue; }
    para.push(t); i++;
  }
  flush();
  return out.join('\n');
}
