// Minimal SVG line chart. series: [{ name, color, points: [{x: Date-ms, y: number, label}] , dashed }]
import { esc } from './md.js';

export function lineChart(series, { height = 200, yLabel = '', yMin = null, yMax = null, rightAxis = null } = {}) {
  const W = 340, H = height, L = 36, R = rightAxis ? 30 : 10, T = 12, B = 24;
  const pts = series.flatMap(s => s.points);
  if (!pts.length) return '<div class="empty small">No data yet.</div>';
  const xs = pts.map(p => p.x);
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  if (x0 === x1) { x0 -= 86400000 * 3; x1 += 86400000 * 3; }
  const mainPts = series.filter(s => !s.right).flatMap(s => s.points).map(p => p.y);
  let y0 = yMin ?? Math.min(...mainPts), y1 = yMax ?? Math.max(...mainPts);
  if (y0 === y1) { y0 -= 5; y1 += 5; }
  const pad = (y1 - y0) * 0.08; if (yMin == null) y0 -= pad; if (yMax == null) y1 += pad;
  const sx = x => L + (x - x0) / (x1 - x0) * (W - L - R);
  const sy = y => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B);
  const syR = rightAxis ? (y => T + (1 - (y - rightAxis.min) / (rightAxis.max - rightAxis.min)) * (H - T - B)) : sy;

  const ticks = 4; let grid = '';
  for (let i = 0; i <= ticks; i++) {
    const v = y0 + (y1 - y0) * i / ticks; const y = sy(v);
    grid += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="rgba(255,255,255,.07)"/>`;
    grid += `<text x="${L - 6}" y="${y + 3.5}" fill="#5f5b55" font-size="9.5" text-anchor="end">${Math.round(v)}</text>`;
  }
  if (rightAxis) for (let i = 0; i <= 2; i++) {
    const v = rightAxis.min + (rightAxis.max - rightAxis.min) * i / 2;
    grid += `<text x="${W - R + 5}" y="${syR(v) + 3.5}" fill="#5f5b55" font-size="9.5">${Math.round(v)}</text>`;
  }
  // x labels: first, middle, last
  const short = (x1 - x0) < 120 * 86400000;
  const fmt = ms => new Date(ms).toLocaleDateString('en-GB', short ? { day: 'numeric', month: 'short' } : { month: 'short', year: '2-digit' });
  const xl = [x0, (x0 + x1) / 2, x1].map((x, i) => `<text x="${sx(x)}" y="${H - 6}" fill="#5f5b55" font-size="9.5" text-anchor="${['start', 'middle', 'end'][i]}">${fmt(x)}</text>`).join('');

  const paths = series.map(s => {
    const f = s.right ? syR : sy;
    const ps = [...s.points].sort((a, b) => a.x - b.x);
    if (!ps.length) return '';
    const d = ps.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${f(p.y).toFixed(1)}`).join('');
    const dots = ps.length <= 40 ? ps.map(p => `<circle cx="${sx(p.x).toFixed(1)}" cy="${f(p.y).toFixed(1)}" r="2.6" fill="${s.color}"><title>${esc(p.label || '')}</title></circle>`).join('') : '';
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.right ? 1.5 : 2.2}" ${s.dashed ? 'stroke-dasharray="4 3"' : ''} stroke-linejoin="round" stroke-linecap="round" opacity="${s.right ? .8 : 1}"/>${dots}`;
  }).join('');
  const legend = series.length > 1 ? `<div class="row tiny muted" style="gap:14px;margin-top:6px;flex-wrap:wrap">${series.map(s => `<span class="row" style="gap:5px"><span style="width:12px;height:3px;border-radius:2px;background:${s.color};display:inline-block"></span>${esc(s.name)}</span>`).join('')}</div>` : '';
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yLabel)}">${grid}${xl}${paths}</svg>${legend}</div>`;
}
