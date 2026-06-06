// House-style print stylesheet (Oracle palette, Segoe UI), shipped as a string so the rendered
// HTML is fully self-contained (no external CSS file). PDF is produced via the browser's print.

export const LAYOUT_CSS = `
:root{--red:#C74634;--green:#16a34a;--blue:#2563eb;--slate:#334155;--muted:#64748b;--line:#e2e8f0;}
*{box-sizing:border-box;}
body{font-family:"Segoe UI",system-ui,-apple-system,sans-serif;color:var(--slate);font-size:9.5pt;line-height:1.45;margin:0;padding:24px;}
h1{color:var(--red);font-size:18pt;margin:0 0 2px;}
h2{color:var(--red);font-size:11pt;margin:16px 0 6px;border-bottom:1.5px solid var(--red);padding-bottom:2px;page-break-after:avoid;}
h3{font-size:10pt;margin:0 0 4px;}
.hdr{border-bottom:2px solid var(--red);padding-bottom:6px;margin-bottom:10px;}
.hdr .meta{color:var(--muted);font-size:8.5pt;}
.hdr .status{text-transform:uppercase;letter-spacing:.04em;color:var(--red);font-weight:700;}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:10px 0;}
.stat{border:1px solid var(--line);border-top:3px solid var(--slate);border-radius:6px;padding:8px;text-align:center;}
.stat.g{border-top-color:var(--green);}
.stat .n{font-size:15pt;font-weight:800;color:var(--slate);}
.stat.g .n{color:var(--green);}
.stat .l{font-size:7.6pt;color:var(--muted);margin-top:2px;}
.fig{text-align:center;margin:10px 0;}
.fig svg{max-width:100%;height:auto;}
.cap{font-size:7.6pt;color:var(--muted);font-style:italic;margin-top:2px;}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:8px 0;}
.card{border:1px solid var(--line);border-left:4px solid var(--slate);border-radius:6px;padding:8px;}
.card.warm{border-left-color:var(--green);}
.card.cold{border-left-color:var(--blue);}
.card .row{display:flex;justify-content:space-between;border-top:1px solid var(--line);padding:2px 0;font-size:8.6pt;}
.pull{background:#fdf6f5;border-left:4px solid var(--red);padding:8px 12px;margin:12px 0;font-style:italic;text-align:center;color:var(--slate);}
table{border-collapse:collapse;width:100%;font-size:8.4pt;margin:6px 0;}
th,td{border:1px solid var(--line);padding:3px 6px;text-align:left;vertical-align:top;}
th{background:#f8fafc;font-weight:700;}
.badge{display:inline-block;padding:0 6px;border-radius:8px;font-size:7.6pt;font-weight:700;color:#fff;}
.badge.high{background:var(--green);}
.badge.medium{background:#d97706;}
.badge.low{background:var(--red);}
ul{margin:4px 0;padding-left:18px;}
li{margin:2px 0;}
.ftr{margin-top:14px;padding-top:6px;border-top:1px solid var(--line);font-size:7.4pt;color:var(--muted);}
@page{size:letter;margin:0.5in;}
@media print{body{padding:0;}h2{page-break-after:avoid;}.fig,.card,table{page-break-inside:avoid;}}
`;
