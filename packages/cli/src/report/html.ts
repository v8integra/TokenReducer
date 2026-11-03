import type { SessionAnalysis } from '@tokentrim/core';
import type { Aggregate } from './aggregate.js';
import { pct, tok } from './format.js';
import { renderMarkdown, type ReportContext } from './markdown.js';

/**
 * Self-contained HTML report: charts on top, then the same tables as the Markdown report (converted, so both
 * formats always agree). No external scripts, fonts or styles; it opens offline.
 */
export function renderHtml(a: Aggregate, ctx: ReportContext): string {
  const md = renderMarkdown(a, ctx);
  const title = md.split('\n')[0]!.replace(/^#\s*/, '');
  const total = a.cost.total;
  const sessions = [...a.sessions].sort((x, y) => y.cost.total - x.cost.total).slice(0, 12);
  const data = sessions.map((s) => sessionSeries(s, ctx));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>${esc(title)}</h1>
<section class="tiles">
${tile('Total cost', `${tok(total)} ITE`, `${a.sessions.length} session(s), ${a.requests.toLocaleString('en-US')} requests`)}
${tile('Cache hit ratio', pct(a.cacheHitRatio, 1), 'share of input tokens read from cache')}
${tile('One clear per segment', `≤ ${pct(a.clearSaving, total)}`, `${tok(a.clearSaving)} ITE upper bound`)}
${tile('Planned guards', pct(a.guardSim.duplicateRead.cost + a.guardSim.largeFile.cost + a.guardSim.noisyCommand.cost, total), 'simulated on these sessions')}
</section>
<section>
<h2>What the cost is spent on</h2>
<p class="note">Share of total cost (input-token equivalents). Hover a bar for details.</p>
${categoryBars(a)}
</section>
<section>
<h2>Context size over each session</h2>
<p class="note">One panel per session, largest first. The line is the context re-sent on each request; dashed lines are compactions; the dot marks the first point where clearing would have paid off within ${ctx.maxBreakevenTurns} requests. Hover for details.</p>
<div class="multiples">${data.map((d, i) => panel(d, i)).join('\n')}</div>
</section>
<section class="tables">
${mdToHtml(md.split('\n').slice(1).join('\n'))}
</section>
</main>
<div id="tip" role="tooltip" hidden></div>
<script>const SERIES = ${JSON.stringify(data)};
${SCRIPT}</script>
</body>
</html>
`;
}

interface Series {
  title: string;
  window: number;
  points: [number, number, number][]; // [request index, context, break-even turns (-1 = never)]
  compactions: number[];
  clearAt: number | null;
  cost: string;
}

function sessionSeries(s: SessionAnalysis, ctx: ReportContext): Series {
  // Thin long sessions to ≤ 400 points, keeping each bucket's peak so spikes survive.
  const pts = s.curve;
  const step = Math.max(1, Math.ceil(pts.length / 400));
  const out: [number, number, number][] = [];
  for (let i = 0; i < pts.length; i += step) {
    const bucket = pts.slice(i, i + step);
    const peak = bucket.reduce((m, p) => (p.context > m.context ? p : m), bucket[0]!);
    out.push([
      peak.i,
      peak.context,
      Number.isFinite(peak.breakevenTurns) ? Math.round(peak.breakevenTurns * 10) / 10 : -1,
    ]);
  }
  return {
    title: ctx.redact.title(s.title, s.sessionId),
    window: s.contextWindow,
    points: out,
    compactions: s.compactions.map((c) => c.beforeRequest),
    clearAt: s.clearPoints[0]?.requestIndex ?? null,
    cost: tok(s.cost.total),
  };
}

const W = 520;
const H = 170;
const PAD = { l: 44, r: 10, t: 10, b: 22 };

function panel(d: Series, idx: number): string {
  const n = Math.max(1, d.points.at(-1)?.[0] ?? 1);
  const x = (i: number) => PAD.l + ((W - PAD.l - PAD.r) * i) / n;
  const y = (v: number) => H - PAD.b - ((H - PAD.t - PAD.b) * v) / d.window;
  const path = d.points
    .map((p, k) => `${k ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`)
    .join('');
  const grid = [0.25, 0.5, 0.75, 1]
    .map(
      (f) =>
        `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(f * d.window)}" y2="${y(f * d.window)}"/><text class="axis" x="${PAD.l - 6}" y="${y(f * d.window) + 3}" text-anchor="end">${tok(f * d.window)}</text>`,
    )
    .join('');
  const comps = d.compactions
    .map((c) => `<line class="compact" x1="${x(c)}" x2="${x(c)}" y1="${PAD.t}" y2="${H - PAD.b}"/>`)
    .join('');
  let clear = '';
  if (d.clearAt !== null) {
    const p = d.points.reduce(
      (m, q) => (Math.abs(q[0] - d.clearAt!) < Math.abs(m[0] - d.clearAt!) ? q : m),
      d.points[0]!,
    );
    clear = `<circle class="clear" cx="${x(p[0])}" cy="${y(p[1])}" r="5"/>`;
  }
  return `<figure class="panel">
<figcaption><span>${esc(d.title)}</span><span class="muted">${d.cost} ITE</span></figcaption>
<svg viewBox="0 0 ${W} ${H}" data-idx="${idx}" role="img" aria-label="Context size per request for ${esc(d.title)}">
<line class="base" x1="${PAD.l}" x2="${W - PAD.r}" y1="${H - PAD.b}" y2="${H - PAD.b}"/>${grid}${comps}
<path class="line" d="${path}"/>${clear}
<text class="axis" x="${PAD.l}" y="${H - 6}">request 0</text><text class="axis" x="${W - PAD.r}" y="${H - 6}" text-anchor="end">${n}</text>
<line class="cross" x1="0" x2="0" y1="${PAD.t}" y2="${H - PAD.b}" visibility="hidden"/><circle class="hover" r="4" visibility="hidden"/>
<rect class="hit" x="${PAD.l}" y="${PAD.t}" width="${W - PAD.l - PAD.r}" height="${H - PAD.t - PAD.b}"/>
</svg>
</figure>`;
}

function categoryBars(a: Aggregate): string {
  const total = a.cost.total || 1;
  const rows = a.categories.filter((c) => c.cost / total >= 0.002).slice(0, 14);
  const max = Math.max(...rows.map((r) => r.cost), 1);
  return `<div class="bars">${rows
    .map(
      (
        r,
      ) => `<div class="bar-row" data-tip="${esc(`${r.category}: ${tok(r.cost)} ITE (${pct(r.cost, total)})`)}">
<span class="bar-label">${esc(r.category)}</span>
<span class="bar-track"><span class="bar" style="width:${((100 * r.cost) / max).toFixed(2)}%"></span></span>
<span class="bar-value">${pct(r.cost, total)}</span></div>`,
    )
    .join('')}</div>`;
}

function tile(label: string, value: string, sub: string): string {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div><div class="tile-sub">${esc(sub)}</div></div>`;
}

/** Just enough Markdown for our own report: headings, paragraphs, lists, tables, `code`, **bold**. */
export function mdToHtml(md: string): string {
  const out: string[] = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim()) continue;
    const h = /^(#{1,3})\s+(.*)$/.exec(l);
    if (h) {
      out.push(`<h${h[1]!.length + 1}>${inline(h[2]!)}</h${h[1]!.length + 1}>`);
    } else if (l.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith('|')) rows.push(splitRow(lines[i++]!));
      i--;
      const [head, , ...body] = rows;
      out.push(
        `<div class="table-wrap"><table><thead><tr>${head!.map((c, k) => `<th${k ? ' class="num"' : ''}>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body
          .map(
            (r) =>
              `<tr>${r.map((c, k) => `<td${k ? ' class="num"' : ''}>${inline(c)}</td>`).join('')}</tr>`,
          )
          .join('')}</tbody></table></div>`,
      );
    } else if (l.startsWith('- ')) {
      const items: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('- ')) items.push(lines[i++]!.slice(2));
      i--;
      out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`);
    } else {
      out.push(`<p>${inline(l)}</p>`);
    }
  }
  return out.join('\n');
}

function splitRow(l: string): string[] {
  return l
    .slice(1, l.endsWith('|') ? -1 : undefined)
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const CSS = `
:root{color-scheme:light;--surface:#fcfcfb;--panel:#ffffff;--border:#e4e3df;--text:#0b0b0b;--text-2:#52514e;--muted:#7a7974;--series:#2a78d6;--track:#efeeea;--grid:#ecebe7;--accent:#e34948;--code:#f2f1ed}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--surface:#1a1a19;--panel:#222221;--border:#3a3a38;--text:#f0efec;--text-2:#c3c2b7;--muted:#97968e;--series:#3987e5;--track:#2c2c2a;--grid:#2e2e2c;--accent:#e66767;--code:#2c2c2a}}
:root[data-theme="dark"]{color-scheme:dark;--surface:#1a1a19;--panel:#222221;--border:#3a3a38;--text:#f0efec;--text-2:#c3c2b7;--muted:#97968e;--series:#3987e5;--track:#2c2c2a;--grid:#2e2e2c;--accent:#e66767;--code:#2c2c2a}
*{box-sizing:border-box}
body{margin:0;background:var(--surface);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1120px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 16px}h2{font-size:17px;margin:32px 0 8px}h3{font-size:15px}
p{color:var(--text-2);margin:6px 0 10px}.note{color:var(--muted);font-size:13px}
code{background:var(--code);padding:1px 4px;border-radius:4px;font-size:12px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.tile{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px}
.tile-label{color:var(--text-2);font-size:12px}.tile-value{font-size:26px;font-weight:600;margin:2px 0}.tile-sub{color:var(--muted);font-size:12px}
.bars{display:grid;gap:6px;background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px}
.bar-row{display:grid;grid-template-columns:minmax(120px,280px) 1fr 56px;gap:10px;align-items:center}
.bar-label{font-size:13px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-track{height:14px;background:var(--track);border-radius:4px;overflow:hidden}
.bar{display:block;height:100%;background:var(--series);border-radius:0 4px 4px 0}
.bar-value{text-align:right;font-variant-numeric:tabular-nums;font-size:13px}
.multiples{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
.panel{margin:0;background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:10px 10px 4px}
.panel figcaption{display:flex;justify-content:space-between;gap:8px;font-size:13px;margin-bottom:4px}
.panel figcaption span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.muted{color:var(--muted)}
svg{width:100%;height:auto;display:block}
.line{fill:none;stroke:var(--series);stroke-width:2;stroke-linejoin:round}
.grid{stroke:var(--grid);stroke-width:1}.base{stroke:var(--border);stroke-width:1}
.axis{fill:var(--muted);font-size:10px;font-variant-numeric:tabular-nums}
.compact{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3}
.clear{fill:var(--accent);stroke:var(--panel);stroke-width:2}
.cross{stroke:var(--muted);stroke-width:1}.hover{fill:var(--series);stroke:var(--panel);stroke-width:2}
.hit{fill:transparent;cursor:crosshair}
.table-wrap{overflow-x:auto;background:var(--panel);border:1px solid var(--border);border-radius:10px;margin:8px 0 12px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{padding:6px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
th{color:var(--text-2);font-weight:600;white-space:nowrap}tr:last-child td{border-bottom:0}
.num{text-align:right;font-variant-numeric:tabular-nums}
td:first-child{max-width:420px;overflow-wrap:anywhere}
#tip{position:fixed;pointer-events:none;background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:6px 8px;font-size:12px;box-shadow:0 4px 14px rgba(0,0,0,.15);z-index:10;max-width:320px}
@media (max-width:600px){.bar-row{grid-template-columns:110px 1fr 48px}}
`;

const SCRIPT = `
(function(){
var tip=document.getElementById('tip');
function fmt(n){var a=Math.abs(n);return a>=1e6?(n/1e6).toFixed(a>=1e8?0:1)+'M':a>=1e3?(n/1e3).toFixed(a>=1e5?0:1)+'K':String(Math.round(n));}
function show(e,html){tip.innerHTML=html;tip.hidden=false;var x=e.clientX+14,y=e.clientY+14;if(x+tip.offsetWidth>innerWidth)x=e.clientX-tip.offsetWidth-14;if(y+tip.offsetHeight>innerHeight)y=e.clientY-tip.offsetHeight-14;tip.style.left=x+'px';tip.style.top=y+'px';}
function hide(){tip.hidden=true;}
document.querySelectorAll('.bar-row').forEach(function(r){r.addEventListener('mousemove',function(e){show(e,r.getAttribute('data-tip').replace(/&/g,'&amp;').replace(/</g,'&lt;'));});r.addEventListener('mouseleave',hide);});
var W=${W},H=${H},P=${JSON.stringify(PAD)};
document.querySelectorAll('svg[data-idx]').forEach(function(svg){
  var d=SERIES[+svg.getAttribute('data-idx')],pts=d.points,n=Math.max(1,pts[pts.length-1][0]);
  var cross=svg.querySelector('.cross'),dot=svg.querySelector('.hover'),hit=svg.querySelector('.hit');
  function x(i){return P.l+(W-P.l-P.r)*i/n;} function y(v){return H-P.b-(H-P.t-P.b)*v/d.window;}
  hit.addEventListener('mousemove',function(e){
    var r=svg.getBoundingClientRect(),i=((e.clientX-r.left)*W/r.width-P.l)/(W-P.l-P.r)*n,best=pts[0];
    for(var k=1;k<pts.length;k++)if(Math.abs(pts[k][0]-i)<Math.abs(best[0]-i))best=pts[k];
    cross.setAttribute('x1',x(best[0]));cross.setAttribute('x2',x(best[0]));cross.setAttribute('visibility','visible');
    dot.setAttribute('cx',x(best[0]));dot.setAttribute('cy',y(best[1]));dot.setAttribute('visibility','visible');
    show(e,'<strong>Request '+best[0]+'</strong><br>Context: '+fmt(best[1])+' ('+Math.round(100*best[1]/d.window)+'% of window)<br>Clearing pays off in: '+(best[2]<0?'never':best[2]+' requests'));
  });
  hit.addEventListener('mouseleave',function(){cross.setAttribute('visibility','hidden');dot.setAttribute('visibility','hidden');hide();});
});
})();
`;
