import { createRequire } from 'module';
import os from 'os';
const require = createRequire(os.homedir() + '/.datastrata/');
const puppeteer = require('puppeteer');

// mirror the artifact publish wrapper (doctype + utf-8) so text renders as it does live
import fs from 'fs';
fs.writeFileSync('_test_page.html', '<!doctype html><html><head><meta charset="utf-8"></head><body>' + fs.readFileSync(new URL('../web/schema_lineage_studio.html', import.meta.url),'utf8') + '</body></html>');
const PAGE_URL = 'http://127.0.0.1:8765/_test_page.html';
const OUT = process.argv[2] || '.';
const results = [];
const check = (name, ok, detail='') => { results.push({name, ok, detail}); console.log((ok?'PASS':'FAIL'), name, detail); };

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
page.on('console', m => { if(m.type() === 'error' && !/Failed to load resource/.test(m.text())) pageErrors.push(m.text()); });
page.on('response', r => { if(r.status() >= 400 && !r.url().endsWith('/favicon.ico')) pageErrors.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto(PAGE_URL, { waitUntil: 'networkidle0' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('.node', { timeout: 15000 });

// ---- static render ----
const stat = await page.evaluate(() => ({
  nodes: document.querySelectorAll('.node:not(.sticky-node)').length,
  boxes: document.querySelectorAll('.group-box').length,
  depHits: document.querySelectorAll('.dep-hit').length,
  refHits: document.querySelectorAll('.ref-hit').length,
  labels: [...document.querySelectorAll('.card-label')].map(t => t.textContent),
  status: document.getElementById('status').textContent,
  layerOrder: [...document.getElementById('viewport').children].map(c => c.id),
}));
check('20 tables rendered', stat.nodes === 20, `nodes=${stat.nodes}`);
check('4 group boxes', stat.boxes === 4, `boxes=${stat.boxes}`);
check('parse status clean', /parsed/.test(stat.status) && !/warning|error/.test(stat.status), stat.status);
check('layer order boxes < edges < nodes', stat.layerOrder.join(',') === 'groupBoxes,edges,nodes', stat.layerOrder.join(','));
check('cardinality labels include 0..1', stat.labels.includes('0..1'), JSON.stringify(stat.labels));
check('cardinality labels include 1 and *', stat.labels.includes('1') && stat.labels.includes('*'));
check('ref + dep hit paths exist', stat.depHits > 0 && stat.refHits > 0, `dep=${stat.depHits} ref=${stat.refHits}`);
// ---- default view: lineage is table-level — exactly one dashed line per source->target table pair ----
// the example has 31 column/table deps across 16 distinct table pairs
const depLines = await page.evaluate(() => ({
  visible: document.querySelectorAll('svg#edges path[stroke-dasharray="6,4"]').length,
  hits: document.querySelectorAll('.dep-hit').length,
}));
check('default shows 16 table-level lineage lines (not 31 column lines)', depLines.visible === 16 && depLines.hits === 16, JSON.stringify(depLines));

// ---- DBML features from the reference example ----
const feat = await page.evaluate(() => {
  const head = id => document.querySelector(`.node[data-id="${id}"] .head`);
  const strokes = [...document.querySelectorAll('svg#edges path')].map(p => (p.getAttribute('stroke') || '').toLowerCase());
  return {
    status: document.getElementById('status').textContent,
    countriesHeader: head('countries') && getComputedStyle(head('countries')).backgroundColor,
    sticky: document.querySelector('.sticky-node')?.innerText || '',
    inactive: document.querySelectorAll('svg#edges path[stroke-dasharray="2,4"]').length,
    redRef: strokes.includes('#c0392b'),
    partialCols: [...document.querySelectorAll('.row[data-table="raw.app_orders"]')].map(r => r.dataset.field).join(','),
    quotedCol: !!document.querySelector('.row[data-table="raw.web_events"][data-field="user agent"]'),
    compositeRefs: [...document.querySelectorAll('.ref-hit')].length,
  };
});
check('status shows project + database type', /ecommerce_analytics \(PostgreSQL\)/.test(feat.status), feat.status);
check('table headercolor wins over group color', feat.countriesHeader === 'rgb(22, 160, 133)', feat.countriesHeader);
check('sticky note rendered', /warehouse_conventions/i.test(feat.sticky) && /raw\.\* is append-only/.test(feat.sticky), JSON.stringify(feat.sticky.slice(0, 80)));
check('[inactive] ref drawn dotted', feat.inactive >= 1, `dotted=${feat.inactive}`);
check('explicit Ref [color] used', feat.redRef);
check('TablePartial columns injected in order', feat.partialCols === 'id,customer_id,product_id,status,placed_at,created_at,updated_at', feat.partialCols);
check('quoted column name rendered', feat.quotedCol);
check('composite FK drawn as 2 lines (15 ref lines total)', feat.compositeRefs === 15, `ref lines=${feat.compositeRefs}`);

// ---- line endpoints are computed as HEAD_H + i*ROW_H + ROW_H/2; the real DOM must agree ----
const align = await page.evaluate(() => {
  const HEAD_H = 30, ROW_H = 26, bad = [];
  document.querySelectorAll('.node:not(.group-node):not(.sticky-node)').forEach(n => {
    const head = n.querySelector('.head');
    if(head.offsetHeight !== HEAD_H) bad.push(`${n.dataset.id} header ${head.offsetHeight}px`);
    const top = head.getBoundingClientRect().top;
    n.querySelectorAll('.row[data-field]').forEach((r, i) => {
      const rr = r.getBoundingClientRect();
      const actual = rr.top + rr.height/2 - top, expected = HEAD_H + i*ROW_H + ROW_H/2;
      if(Math.abs(actual - expected) > 2) bad.push(`${n.dataset.id}.${r.dataset.field} off by ${(actual-expected).toFixed(1)}px`);
    });
  });
  return bad;
});
check('every row sits exactly where its line endpoints are drawn', align.length === 0, JSON.stringify(align.slice(0, 6)));

// ---- group boxes must not overlap each other, and must not swallow other groups' tables ----
const overlap = await page.evaluate(() => {
  const r = el => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width) || el.offsetWidth, h: parseFloat(el.style.height) || el.offsetHeight });
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const boxes = [...document.querySelectorAll('.group-box')].map(b => ({ g: b.dataset.group, ...r(b) }));
  const boxPairs = [];
  for(let i = 0; i < boxes.length; i++) for(let j = i+1; j < boxes.length; j++) if(hit(boxes[i], boxes[j])) boxPairs.push(boxes[i].g + ' x ' + boxes[j].g);
  const intruders = [];
  document.querySelectorAll('.node').forEach(n => {
    const nr = { x: parseFloat(n.style.left), y: parseFloat(n.style.top), w: n.offsetWidth, h: n.offsetHeight };
    boxes.forEach(b => { if(b.g !== n.dataset.group && hit(nr, b)) intruders.push(n.dataset.id + ' in ' + b.g); });
  });
  return { boxPairs, intruders };
});
check('no two group boxes overlap', overlap.boxPairs.length === 0, JSON.stringify(overlap.boxPairs));
check('no table sits inside another group\'s box', overlap.intruders.length === 0, JSON.stringify(overlap.intruders));
await page.screenshot({ path: `${OUT}/e2e_1_static.png` });

// helper: screen point at the middle of an SVG path
async function midpointOf(selector, index=0){
  return page.evaluate((sel, i) => {
    const p = document.querySelectorAll(sel)[i];
    const len = p.getTotalLength();
    // try a few points along the path for one that is actually on-screen and topmost
    for(const f of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9]){
      const pt = p.getPointAtLength(len * f);
      const m = p.getScreenCTM();
      const x = pt.x * m.a + pt.y * m.c + m.e, y = pt.x * m.b + pt.y * m.d + m.f;
      if(x > 0 && y > 0 && x < innerWidth && y < innerHeight && document.elementFromPoint(x, y) === p) return {x, y};
    }
    return null;
  }, selector, index);
}

// ---- hover a Dep line ----
let depPt = null, depIdx = 0;
for(let i = 0; i < stat.depHits && !depPt; i++){ depPt = await midpointOf('.dep-hit', i); depIdx = i; }
if(depPt){
  await page.mouse.move(depPt.x, depPt.y);
  await new Promise(r => setTimeout(r, 400));
  const s = await page.evaluate(() => ({
    tooltip: document.getElementById('depTooltip').classList.contains('show'),
    tipText: document.getElementById('depTooltip').innerText.slice(0, 200),
    flow: !!document.querySelector('.edge-flow.dep-flow'),
    flowStroke: document.querySelector('.edge-flow')?.style.stroke || '',
    anim: document.querySelector('.edge-flow') ? getComputedStyle(document.querySelector('.edge-flow')).animationName : '',
  }));
  check('dep hover shows tooltip', s.tooltip, JSON.stringify(s.tipText));
  check('dep hover shows flow overlay', s.flow, `stroke=${s.flowStroke}`);
  check('dep flow is animated', s.anim === 'edgeFlow', s.anim);
  await page.screenshot({ path: `${OUT}/e2e_2_dep_hover.png` });
  await page.mouse.move(5, 500);
  await new Promise(r => setTimeout(r, 400));
  const gone = await page.evaluate(() => !document.querySelector('.edge-flow') && !document.getElementById('depTooltip').classList.contains('show'));
  check('dep hover clears on leave', gone);
} else check('found a hoverable dep line on screen', false);

// ---- hover a column: card shows name, type, note, lineage ----
async function hoverEl(selector){
  const r = await page.evaluate(sel => { const el = document.querySelector(sel); if(!el) return null; el.scrollIntoView({block:'center', inline:'center'}); const b = el.getBoundingClientRect(); return { x: b.x + b.width/2, y: b.y + b.height/2 }; }, selector);
  if(!r) return null;
  await page.mouse.move(r.x, r.y);
  await new Promise(res => setTimeout(res, 350));
  return page.evaluate(() => ({ shown: document.getElementById('depTooltip').classList.contains('show'), text: document.getElementById('depTooltip').innerText }));
}
const col = await hoverEl('.row[data-table="staging.stg_payments"][data-field="gross_amount"]');
check('column hover shows card', !!col && col.shown);
check('column card has name + type', !!col && /gross_amount/.test(col.text) && /decimal\(12,2\)/.test(col.text), JSON.stringify(col && col.text.slice(0, 60)));
check('column card has note', !!col && /Divided by 100\. Stripe stores cents\./.test(col.text));
check('column card has lineage (built from / feeds)', !!col && /Built from/i.test(col.text) && /raw\.stripe_charges\.amount_cents/.test(col.text) && /Feeds/i.test(col.text) && /marts\.fct_orders\.net_amount/.test(col.text));
await page.screenshot({ path: `${OUT}/e2e_col_hover.png` });

// ---- hovering a column lights up exactly its direct upstream + downstream lines ----
const litFor = async (t, f) => { await hoverEl(`.row[data-table="${t}"][data-field="${f}"]`); return page.evaluate(() => document.querySelectorAll('.edge-flow.dep-flow').length); };
const expectLit = [
  ['staging.stg_payments', 'gross_amount', 2],   // in: raw amount_cents  | out: fct_orders.net_amount
  ['marts.fct_orders', 'net_amount', 4],          // in: gross, refund     | out: revenue_daily.revenue, ltv.lifetime_revenue
  ['staging.stg_customers', 'email', 2],          // in: whole-table dep from raw.app_customers | out: dim_customers.email
  ['raw.app_orders', 'status', 0],                // no column-level lineage
];
for(const [t, f, n] of expectLit){
  const got = await litFor(t, f);
  check(`hover ${t}.${f} lights ${n} lineage line(s)`, got === n, `lit=${got}`);
}
await hoverEl('.row[data-table="marts.fct_orders"][data-field="net_amount"]');
await page.screenshot({ path: `${OUT}/e2e_col_lines.png` });
await page.mouse.move(5, 500);
await new Promise(r => setTimeout(r, 300));
check('column line highlight clears on leave', await page.evaluate(() => document.querySelectorAll('.edge-flow').length === 0));

// ---- click a column to trace: the chain is drawn column-to-column ----
await page.evaluate(() => document.querySelector('.row[data-table="marts.mart_revenue_daily"][data-field="revenue"]').scrollIntoView({block:'center', inline:'center'}));
await page.click('.row[data-table="marts.mart_revenue_daily"][data-field="revenue"]');
await new Promise(r => setTimeout(r, 300));
const trace = await page.evaluate(() => ({
  bar: document.getElementById('tracebar').classList.contains('show'),
  glow: document.querySelectorAll('svg#edges path[stroke="var(--edge-dep-glow)"]').length,
}));
// revenue <- net_amount <- gross/refund <- amount_cents/refunded_cents, plus net_amount -> ltv.lifetime_revenue
check('trace draws the column-level chain', trace.bar && trace.glow >= 5, JSON.stringify(trace));
await page.screenshot({ path: `${OUT}/e2e_trace.png` });
await page.click('#traceClose');
await new Promise(r => setTimeout(r, 200));
check('closing trace removes column-level lines', await page.evaluate(() => document.querySelectorAll('svg#edges path[stroke="var(--edge-dep-glow)"]').length === 0));
await page.evaluate(() => { const c = document.getElementById('canvasPane'); c.scrollTop = 0; c.scrollLeft = 0; });
const colRel = await hoverEl('.row[data-table="staging.stg_customers"][data-field="customer_id"]');
check('column card lists relationships with optionality', !!colRel && /zero-or-one/.test(colRel.text) && /Relationships/i.test(colRel.text), JSON.stringify(colRel && colRel.text));
const nn = await page.evaluate(() => document.querySelector('.row[data-table="marts.fct_orders"][data-field="net_amount"] .nn-badge') !== null);
check('NOT NULL column shows NN badge', nn);
const tbl = await hoverEl('.node[data-id="marts.fct_orders"] .head');
check('table header hover shows table card with note', !!tbl && tbl.shown && /One row per order/.test(tbl.text), JSON.stringify(tbl && tbl.text.slice(0, 80)));

// ---- richer cards from the reference example ----
const enumCard = await hoverEl('.row[data-table="marts.fct_orders"][data-field="state"]');
check('enum column card lists enum values', !!enumCard && /Enum values/i.test(enumCard.text) && /complete/.test(enumCard.text) && /cancelled/.test(enumCard.text), JSON.stringify(enumCard && enumCard.text.slice(0, 200)));
const chkCard = await hoverEl('.row[data-table="raw.stripe_charges"][data-field="amount_cents"]');
check('column card shows check expression', !!chkCard && /amount_cents >= 0/.test(chkCard.text));
const propCard = await hoverEl('.row[data-table="staging.stg_customers"][data-field="email"]');
check('column card shows custom property + escaped quote', !!propCard && /masking: partial/i.test(propCard.text) && /customer's login/.test(propCard.text), JSON.stringify(propCard && propCard.text.slice(0, 200)));
const relCard = await hoverEl('.row[data-table="marts.fct_orders"][data-field="customer_id"]');
check('relationship lists actions', !!relCard && /on delete restrict/.test(relCard.text) && /on update cascade/.test(relCard.text), JSON.stringify(relCard && relCard.text.slice(-200)));
const aliasCard = await hoverEl('.node[data-id="raw.stripe_charges"] .head');
check('table card: alias + indexes', !!aliasCard && /alias charges/i.test(aliasCard.text) && /Indexes/i.test(aliasCard.text) && /ix_charges_status_time/.test(aliasCard.text), JSON.stringify(aliasCard && aliasCard.text.slice(0, 200)));
const partCard = await hoverEl('.node[data-id="raw.app_customers"] .head');
check('table card: partials used', !!partCard && /~audit_columns/.test(partCard.text) && /~soft_delete/.test(partCard.text));
const recCard = await hoverEl('.node[data-id="countries"] .head');
check('table card: sample rows from records', !!recCard && /3 sample rows/.test(recCard.text), JSON.stringify(recCard && recCard.text.slice(0, 160)));
const metaCard = await hoverEl('.node[data-id="staging.stg_customers"] .head');
check('Metadata block props on table card', !!metaCard && /owner: crm-team/i.test(metaCard.text));
const ordersFacts = await (async () => {
  const pt = await page.evaluate(() => {
    const p = document.querySelector('.dep-hit[data-pair="staging.stg_orders>marts.fct_orders"]');
    if(!p) return null;
    p.scrollIntoView({ block:'center', inline:'center' });
    const len = p.getTotalLength(), m = p.getScreenCTM();
    for(const f of [0.5, 0.35, 0.65, 0.2, 0.8]){
      const q = p.getPointAtLength(len * f), x = q.x*m.a + q.y*m.c + m.e, y = q.x*m.b + q.y*m.d + m.f;
      if(document.elementFromPoint(x, y) === p) return { x, y };
    }
    return null;
  });
  if(!pt) return null;
  await page.mouse.move(pt.x, pt.y); await new Promise(r => setTimeout(r, 350));
  return page.evaluate(() => document.getElementById('depTooltip').innerText);
})();
check('named Dep block card: name, metadata, query SQL', !!ordersFacts && /order_facts/.test(ordersFacts) && /materialized: incremental/i.test(ordersFacts) && /owner: data-platform/i.test(ordersFacts) && /JOIN staging\.stg_payments/.test(ordersFacts), JSON.stringify(ordersFacts && ordersFacts.slice(0, 300)));
await page.screenshot({ path: `${OUT}/e2e_named_dep.png` });
await page.mouse.move(5, 500);
await page.evaluate(() => { const c = document.getElementById('canvasPane'); c.scrollTop = 0; c.scrollLeft = 0; });
await page.mouse.move(5, 500);
await new Promise(r => setTimeout(r, 300));
// scrollIntoView may have scrolled the canvas; keep later steps predictable
await page.evaluate(() => { const c = document.getElementById('canvasPane'); c.scrollTop = 0; c.scrollLeft = 0; });

// ---- hover a Ref line ----  (zoom out first — refs live between staging/marts, off-screen at 100%)
for(let i = 0; i < 5; i++){ await page.click('#zoomout'); }
await new Promise(r => setTimeout(r, 200));
const zoomLabel = await page.$eval('#zoomlabel', el => el.textContent);
check('zoom-out button works', zoomLabel === '50%', zoomLabel);
let refPt = null;
for(let i = 0; i < stat.refHits && !refPt; i++) refPt = await midpointOf('.ref-hit', i);
if(refPt){
  await page.mouse.move(refPt.x, refPt.y);
  await new Promise(r => setTimeout(r, 400));
  const s = await page.evaluate(() => ({
    flow: !!document.querySelector('.edge-flow.ref-flow'),
    tooltip: document.getElementById('depTooltip').classList.contains('show'),
  }));
  check('ref hover shows flow overlay', s.flow);
  check('ref hover does not show dep tooltip', !s.tooltip);
  await page.screenshot({ path: `${OUT}/e2e_3_ref_hover.png` });
  await page.mouse.move(5, 500);
  await new Promise(r => setTimeout(r, 200));
  // flow direction: for a many->one ref the overlay must run reversed (dots go one -> many)
  const dirOk = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.ref-hit').forEach(h => out.push(h.dataset.reverse));
    return out;
  });
  check('many->one refs flagged to reverse flow', dirOk.includes('1') && dirOk.includes('0'), JSON.stringify(dirOk));
} else check('found a hoverable ref line on screen', false);

// ---- drag a group box ----
const before = await page.evaluate(() => {
  const box = document.querySelector('.group-box');
  const g = box.dataset.group;
  const head = box.querySelector('.group-box-head span').getBoundingClientRect();
  const members = [...document.querySelectorAll(`.node[data-group="${g}"]`)].map(n => ({ id: n.dataset.id, x: parseFloat(n.style.left), y: parseFloat(n.style.top) }));
  const others = [...document.querySelectorAll('.node')].filter(n => n.dataset.group !== g).slice(0, 3).map(n => ({ id: n.dataset.id, x: parseFloat(n.style.left), y: parseFloat(n.style.top) }));
  return { g, hx: head.left + head.width/2, hy: head.top + head.height/2, members, others };
});
await page.mouse.move(before.hx, before.hy);
await page.mouse.down();
for(let i = 1; i <= 10; i++) await page.mouse.move(before.hx + i*12, before.hy + i*6);
await page.mouse.up();
await new Promise(r => setTimeout(r, 200));
const after = await page.evaluate((g) => {
  const members = [...document.querySelectorAll(`.node[data-group="${g}"]`)].map(n => ({ id: n.dataset.id, x: parseFloat(n.style.left), y: parseFloat(n.style.top) }));
  return { members };
}, before.g);
const afterOthers = await page.evaluate((ids) => ids.map(id => { const n = document.querySelector(`.node[data-id="${CSS.escape(id)}"]`); return { id, x: parseFloat(n.style.left), y: parseFloat(n.style.top) }; }), before.others.map(o => o.id));
const deltas = before.members.map(m => { const a = after.members.find(x => x.id === m.id); return { dx: +(a.x - m.x).toFixed(2), dy: +(a.y - m.y).toFixed(2) }; });
const allSame = deltas.every(d => d.dx === deltas[0].dx && d.dy === deltas[0].dy);
check(`group "${before.g}" drag moved its ${deltas.length} tables`, deltas[0].dx !== 0 || deltas[0].dy !== 0, JSON.stringify(deltas[0]));
check('group drag kept relative positions (same delta for all members)', allSame, JSON.stringify(deltas));
const othersStill = before.others.every((o, i) => o.x === afterOthers[i].x && o.y === afterOthers[i].y);
check('tables outside the group did not move', othersStill);
await page.screenshot({ path: `${OUT}/e2e_4_group_drag.png` });

// ---- single-table drag still works ----
const one = await page.evaluate(() => { const n = document.querySelectorAll('.node')[5]; const h = n.querySelector('.head').getBoundingClientRect(); return { id: n.dataset.id, x: parseFloat(n.style.left), hx: h.left + 20, hy: h.top + h.height/2 }; });
await page.mouse.move(one.hx, one.hy); await page.mouse.down();
for(let i = 1; i <= 5; i++) await page.mouse.move(one.hx + i*10, one.hy);
await page.mouse.up();
const oneAfter = await page.evaluate((id) => parseFloat(document.querySelector(`.node[data-id="${CSS.escape(id)}"]`).style.left), one.id);
const curScale = parseInt(await page.$eval('#zoomlabel', el => el.textContent)) / 100;
check('single table drag still works', Math.abs(oneAfter - one.x - 50/curScale) < 1, `moved ${oneAfter - one.x}px at scale ${curScale}`);

// ---- group color palette (button on each group box header) ----
// start from a fresh layout: earlier checks dragged Source Systems on top of Staging's header
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' }); await page.waitForSelector('.node');
check('legend no longer says "lines colored by source table"', await page.$eval('#legend', el => !/lines colored by/i.test(el.textContent)));
const pal = await page.evaluate(() => ({ n: document.querySelectorAll('.group-box-palette').length }));
check('palette button on every group box', pal.n === 4, `n=${pal.n}`);
const stagingState = () => page.evaluate(() => {
  const box = document.querySelector('.group-box[data-group="Staging"]');
  const head = document.querySelector('.node[data-id="staging.stg_orders"] .head');
  const treeSw = document.querySelector('.tree-color[data-key="Staging"]');
  return { left: box && box.style.left, gbc: box && getComputedStyle(box).getPropertyValue('--gbc').trim(), head: head && getComputedStyle(head).backgroundColor, tree: treeSw && treeSw.value };
});
const palBefore = await stagingState();
await page.evaluate(() => document.querySelector('.group-box[data-group="Staging"] .group-box-palette').scrollIntoView({ block:'center', inline:'center' }));
await page.click('.group-box[data-group="Staging"] .group-box-palette');
await new Promise(r => setTimeout(r, 200));
const pop = await page.evaluate(() => {
  const el = document.getElementById('colorPop');
  return { open: !el.hidden, theme: el.querySelectorAll('.cp-grid')[0].children.length, used: [...el.querySelectorAll('.cp-grid')[1].children].map(b => b.dataset.color), hex: el.querySelector('#cpHex').value };
});
check('palette opens with 15 theme colors + colors in use + hex', pop.open && pop.theme === 15 && pop.used.includes('#3a6df0') && pop.hex === '#3a6df0', JSON.stringify(pop));
const afterOpen = await stagingState();
check('opening the palette does not drag the group', afterOpen.left === palBefore.left, `${palBefore.left} -> ${afterOpen.left}`);
await page.click('#colorPop .cp-sw[data-color="#5a9e4b"]'); await new Promise(r => setTimeout(r, 200));
let st = await stagingState();
const popStill = await page.evaluate(() => !document.getElementById('colorPop').hidden && !!document.querySelector('#colorPop .cp-sw.sel[data-color="#5a9e4b"]'));
check('theme swatch recolors the group box and its tables', st.gbc === '#5a9e4b' && st.head === 'rgb(90, 158, 75)', JSON.stringify(st));
check('right-panel swatch stays in sync', st.tree === '#5a9e4b', st.tree);
check('popover stays open with the choice marked', popStill);
await page.click('#cpHex'); await page.keyboard.type('zz'); await page.keyboard.press('Enter'); await new Promise(r => setTimeout(r, 150));
const err = await page.evaluate(() => ({ msg: document.getElementById('cpErr').textContent, invalid: document.getElementById('cpHex').getAttribute('aria-invalid') }));
st = await stagingState();
check('invalid hex shows an error and changes nothing', /hex color/i.test(err.msg) && err.invalid === 'true' && st.gbc === '#5a9e4b', JSON.stringify(err));
await page.click('#cpHex'); await page.keyboard.type('#123'); await page.click('#cpApply'); await new Promise(r => setTimeout(r, 200));
st = await stagingState();
check('custom short hex #123 applied as #112233', st.gbc === '#112233' && st.head === 'rgb(17, 34, 51)', JSON.stringify(st));
await page.click('#cpReset'); await new Promise(r => setTimeout(r, 200));
st = await stagingState();
check('reset restores the color from the file', st.gbc === '#3a6df0' && st.head === 'rgb(58, 109, 240)', JSON.stringify(st));
await page.keyboard.press('Escape'); await new Promise(r => setTimeout(r, 100));
check('Esc closes the palette', await page.$eval('#colorPop', el => el.hidden));
await page.evaluate(() => { const c = document.getElementById('canvasPane'); c.scrollTop = 0; c.scrollLeft = 0; });

// ---- "highlight all lines" toggle (button + H shortcut) ----
const flowAll = () => page.evaluate(() => ({
  all: document.querySelectorAll('.edge-flow.flow-all').length,
  ref: document.querySelectorAll('.edge-flow.ref-flow.flow-all').length,
  dep: document.querySelectorAll('.edge-flow.dep-flow.flow-all').length,
  pressed: document.getElementById('flowAllBtn').getAttribute('aria-pressed'),
  anim: [...document.querySelectorAll('.edge-flow.flow-all')].every(el => getComputedStyle(el).animationName === 'edgeFlow'),
}));
let fa = await flowAll();
check('highlight-all off by default', fa.all === 0 && fa.pressed === 'false', JSON.stringify(fa));
await page.click('#flowAllBtn'); await new Promise(r => setTimeout(r, 150));
fa = await flowAll();
check('highlight-all animates every visible line (15 ref + 16 lineage)', fa.all === 31 && fa.ref === 15 && fa.dep === 16 && fa.anim && fa.pressed === 'true', JSON.stringify(fa));
await page.click('#chip-ref'); await new Promise(r => setTimeout(r, 150));
fa = await flowAll();
check('highlight-all follows the view mode (Ref only -> 15)', fa.all === 15 && fa.dep === 0, JSON.stringify(fa));
await page.click('#chip-both'); await new Promise(r => setTimeout(r, 150));
// hover still adds its own (glowing) highlight on top, and leaving it doesn't turn highlight-all off
let refPt2 = null;
const nRef = await page.$$eval('.ref-hit', els => els.length);
for(let i = 0; i < nRef && !refPt2; i++) refPt2 = await midpointOf('.ref-hit', i);
if(refPt2){
  await page.mouse.move(refPt2.x, refPt2.y); await new Promise(r => setTimeout(r, 250));
  const hov = await page.evaluate(() => document.querySelectorAll('.edge-flow:not(.flow-all)').length);
  await page.mouse.move(5, 500); await new Promise(r => setTimeout(r, 250));
  fa = await flowAll();
  check('hover highlight works on top of highlight-all', hov === 1 && fa.all === 31, `hover=${hov} all=${fa.all}`);
}
// H while typing in the editor must NOT toggle
await page.$eval('#src', el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }); await page.keyboard.type('h');
await new Promise(r => setTimeout(r, 400));
fa = await flowAll();
const srcEndsWithH = await page.$eval('#src', el => el.value.endsWith('h'));
check('typing "h" in the editor types it, does not toggle', fa.pressed === 'true' && srcEndsWithH, JSON.stringify({ pressed: fa.pressed, srcEndsWithH }));
await page.keyboard.press('Backspace'); await new Promise(r => setTimeout(r, 400));
// trace pauses it; closing the trace brings it back
await page.evaluate(() => document.querySelector('.row[data-table="marts.mart_revenue_daily"][data-field="revenue"]').scrollIntoView({block:'center', inline:'center'}));
await page.click('.row[data-table="marts.mart_revenue_daily"][data-field="revenue"]'); await new Promise(r => setTimeout(r, 200));
const duringTrace = (await flowAll()).all;
await page.click('#traceClose'); await new Promise(r => setTimeout(r, 200));
check('trace pauses highlight-all, closing resumes it', duringTrace === 0 && (await flowAll()).all === 31, `during=${duringTrace}`);
// persists across reload
await page.reload({ waitUntil: 'networkidle0' }); await page.waitForSelector('.node');
fa = await flowAll();
check('highlight-all remembered after reload', fa.all === 31 && fa.pressed === 'true', JSON.stringify(fa));
await page.screenshot({ path: `${OUT}/e2e_highlight_all.png` });
// H key (focus outside inputs) turns it off
await page.evaluate(() => document.activeElement && document.activeElement.blur());
await page.keyboard.press('h'); await new Promise(r => setTimeout(r, 150));
fa = await flowAll();
check('H shortcut toggles it off', fa.all === 0 && fa.pressed === 'false', JSON.stringify(fa));

// ---- detail level: All / Keys ----
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' }); await page.waitForSelector('.node');
const rowsOf = id => page.evaluate(id => [...document.querySelectorAll(`.node[data-id="${id}"] .row`)].map(r => r.dataset.field || r.textContent.trim()), id);
const allRows = await rowsOf('raw.stripe_charges');
check('All shows every column by default', allRows.length === 8 && !allRows.some(x => /hidden/.test(x)), JSON.stringify(allRows));
// keyboard: open menu -> focus lands on the checked item; arrows move; Esc returns focus to the button
await page.focus('#detailChip'); await page.keyboard.press('Enter'); await new Promise(r => setTimeout(r, 100));
let menu = await page.evaluate(() => ({ open: !document.getElementById('detailMenu').hidden, focus: document.activeElement.dataset.level, expanded: document.getElementById('detailChip').getAttribute('aria-expanded') }));
check('detail menu opens with focus on the current level', menu.open && menu.focus === 'all' && menu.expanded === 'true', JSON.stringify(menu));
await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape'); await new Promise(r => setTimeout(r, 100));
menu = await page.evaluate(() => ({ open: !document.getElementById('detailMenu').hidden, focusChip: document.activeElement.id === 'detailChip' }));
check('Esc closes the menu and returns focus', !menu.open && menu.focusChip, JSON.stringify(menu));
await page.click('#detailChip'); await page.click('.dm-item[data-level="keys"]'); await new Promise(r => setTimeout(r, 250));
const kState = await page.evaluate(() => ({ label: document.getElementById('detailLabel').textContent, open: !document.getElementById('detailMenu').hidden }));
check('choosing Keys updates the button and closes the menu', kState.label === 'Keys' && !kState.open, JSON.stringify(kState));
const keyRows = await rowsOf('raw.stripe_charges');
check('Keys: stripe_charges shows its PK + "+7 hidden fields"', JSON.stringify(keyRows) === JSON.stringify(['charge_id', '+7 hidden fields']), JSON.stringify(keyRows));
const itemsRows = await rowsOf('marts.fct_order_items');
check('Keys: composite PK + composite FK columns kept', JSON.stringify(itemsRows) === JSON.stringify(['order_id', 'line_no', 'product_id', 'currency', '+2 hidden fields']), JSON.stringify(itemsRows));
const pkIcons = await page.evaluate(() => ['product_id', 'currency'].map(f => !!document.querySelector(`.row[data-table="marts.dim_product_prices"][data-field="${f}"] .pk`)));
check('composite PK columns get the key icon', pkIcons.every(Boolean), JSON.stringify(pkIcons));
const hiddenTitle = await page.$eval('.node[data-id="raw.stripe_charges"] .hidden-fields', el => el.title);
check('hidden-fields row lists the hidden names on hover', /order_ref/.test(hiddenTitle) && /created_at/.test(hiddenTitle), hiddenTitle);
const kLines = await page.evaluate(() => ({ ref: document.querySelectorAll('.ref-hit').length, dep: document.querySelectorAll('.dep-hit').length }));
check('Keys: all 15 relationship + 16 lineage lines still drawn', kLines.ref === 15 && kLines.dep === 16, JSON.stringify(kLines));
const kAlign = await page.evaluate(() => {
  const HEAD_H = 30, ROW_H = 26, bad = [];
  document.querySelectorAll('.node:not(.group-node):not(.sticky-node)').forEach(n => {
    const top = n.querySelector('.head').getBoundingClientRect().top;
    n.querySelectorAll('.row[data-field]').forEach((r, i) => {
      const rr = r.getBoundingClientRect(), actual = rr.top + rr.height/2 - top, expected = HEAD_H + i*ROW_H + ROW_H/2;
      if(Math.abs(actual - expected) > 2) bad.push(`${n.dataset.id}.${r.dataset.field} off ${(actual-expected).toFixed(1)}`);
    });
  });
  return bad;
});
check('Keys: rows still line up with line endpoints', kAlign.length === 0, JSON.stringify(kAlign.slice(0, 5)));
// hover a column whose lineage targets are hidden: those lines must land on the target's header
await hoverEl('.row[data-table="marts.fct_orders"][data-field="order_id"]');
const hdr = await page.evaluate(() => {
  const ends = [...document.querySelectorAll('.edge-flow.dep-flow:not(.flow-all)')].map(p => {
    const pt = p.getPointAtLength(p.getTotalLength()), m = p.getScreenCTM();
    return { x: pt.x*m.a + pt.y*m.c + m.e, y: pt.x*m.b + pt.y*m.d + m.f };
  });
  const h = document.querySelector('.node[data-id="marts.mart_revenue_daily"] .head').getBoundingClientRect();
  return { n: ends.length, hitsHeader: ends.some(e => Math.abs(e.y - (h.top + h.height/2)) < 3 && Math.abs(e.x - h.left) < 4) };
});
check('Keys: line to a hidden column attaches at that table\'s header', hdr.n === 3 && hdr.hitsHeader, JSON.stringify(hdr));
await page.mouse.move(5, 500);
// saved View remembers the detail level
await page.click('#viewsChip'); await page.type('#viewNameInput', 'keys only'); await page.click('#viewSaveBtn');
await page.click('#detailChip'); await page.click('.dm-item[data-level="all"]'); await new Promise(r => setTimeout(r, 200));
check('switching back to All restores every column', (await rowsOf('raw.stripe_charges')).length === 8);
await page.click('#viewsChip'); await new Promise(r => setTimeout(r, 100));
await page.evaluate(() => [...document.querySelectorAll('.vp-apply')].find(e => e.dataset.name === 'keys only').click());
await new Promise(r => setTimeout(r, 200));
check('applying a saved View restores Keys mode', (await page.$eval('#detailLabel', el => el.textContent)) === 'Keys' && (await rowsOf('raw.stripe_charges')).length === 2);
await page.reload({ waitUntil: 'networkidle0' }); await page.waitForSelector('.node');
check('detail level remembered after reload', (await page.$eval('#detailLabel', el => el.textContent)) === 'Keys' && (await rowsOf('raw.stripe_charges')).length === 2);
await page.screenshot({ path: `${OUT}/e2e_keys.png` });

// ---- tabs: each tab = one DBML document + its own diagram state ----
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle0' }); await page.waitForSelector('.node');
const tabInfo = () => page.evaluate(() => ({
  names: [...document.querySelectorAll('.tab .tab-name')].map(e => e.textContent),
  active: document.querySelector('.tab.active .tab-name')?.textContent,
  tables: document.querySelectorAll('.node:not(.sticky-node):not(.group-node)').length,
  src: document.getElementById('src').value,
  dirtyDots: document.querySelectorAll('.tab.dirty').length,
}));
let ti = await tabInfo();
check('first run: one tab, "Pipeline example"', ti.names.length === 1 && ti.active === 'Pipeline example' && ti.tables === 20, JSON.stringify(ti));
// tab 1: drag a table and hide a group
const posOf = id => page.evaluate(id => { const n = document.querySelector(`.node[data-id="${id}"]`); return n && [n.style.left, n.style.top].join(','); }, id);
await page.evaluate(() => document.querySelector('.node[data-id="countries"] .head').scrollIntoView({ block:'center', inline:'center' }));
const hd = await page.evaluate(() => { const r = document.querySelector('.node[data-id="countries"] .head').getBoundingClientRect(); return { x: r.x + 30, y: r.y + r.height/2 }; });
await page.mouse.move(hd.x, hd.y); await page.mouse.down(); await page.mouse.move(hd.x + 80, hd.y + 40, { steps: 6 }); await page.mouse.up();
const tab1Pos = await posOf('countries');
await page.click('.tree-eye[data-scope="bucket"][data-key="Marketing Marts"]'); await new Promise(r => setTimeout(r, 150));
check('tab 1: hiding a group works', (await tabInfo()).tables === 17);
// new tab: empty, then its own schema
await page.click('#tabAdd'); await new Promise(r => setTimeout(r, 150));
ti = await tabInfo();
check('+ opens an empty "Untitled" tab', ti.names.length === 2 && ti.active === 'Untitled' && ti.src === '' && ti.tables === 0, JSON.stringify(ti));
await page.$eval('#src', el => el.focus());
await page.keyboard.type('Project orders_demo {\n}\nTable users {\n  id int [pk]\n}\nTable orders {\n  id int [pk]\n  user_id int [ref: > users.id]\n}\n');
await new Promise(r => setTimeout(r, 500));
ti = await tabInfo();
check('untitled tab names itself after its Project', ti.active === 'orders_demo' && ti.tables === 2, JSON.stringify(ti));
// back to tab 1: its layout + hidden group are intact
await page.click('.tab-btn[data-id]:not([aria-selected="true"])'); await new Promise(r => setTimeout(r, 200));
ti = await tabInfo();
check('switching back restores tab 1 content, hidden group and dragged position', ti.active === 'Pipeline example' && ti.tables === 17 && (await posOf('countries')) === tab1Pos, JSON.stringify({ ti, pos: await posOf('countries'), tab1Pos }));
// and tab 2 did not inherit tab 1's hidden group
await page.click('.tab-btn[data-id]:not([aria-selected="true"])'); await new Promise(r => setTimeout(r, 200));
check('tab 2 keeps its own state', (await tabInfo()).tables === 2);
// import through the file picker (multiple files)
fs.writeFileSync('/tmp/import_a.dbml', 'Table a_one {\n  id int [pk]\n}\n');
fs.writeFileSync('/tmp/import_b.dbml', 'Table b_one {\n  id int [pk]\n}\nTable b_two {\n  id int [pk]\n  one_id int [ref: > b_one.id]\n}\n');
const input = await page.$('#importInput');
await input.uploadFile('/tmp/import_a.dbml', '/tmp/import_b.dbml');
await new Promise(r => setTimeout(r, 400));
ti = await tabInfo();
check('Import opens each file in its own new tab', ti.names.length === 4 && ti.names.includes('import_a.dbml') && ti.active === 'import_b.dbml' && ti.tables === 2, JSON.stringify(ti));
// drag & drop a file onto the window
await page.evaluate(() => {
  const dt = new DataTransfer();
  dt.items.add(new File(['Table dropped_t {\n  id int [pk]\n}\n'], 'dropped.dbml', { type: 'text/plain' }));
  document.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
  document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
});
await new Promise(r => setTimeout(r, 400));
ti = await tabInfo();
check('dropping a .dbml opens it in a new tab', ti.active === 'dropped.dbml' && ti.tables === 1 && (await page.$eval('#dropOverlay', el => el.hidden)), JSON.stringify(ti));
check('no unsaved dots in the browser version', ti.dirtyDots === 0);
// rename
await page.click('.tab.active .tab-btn', { count: 2, clickCount: 2 }); await new Promise(r => setTimeout(r, 100));
await page.keyboard.type('Dropped schema'); await page.keyboard.press('Enter'); await new Promise(r => setTimeout(r, 150));
check('double-click renames a tab', (await tabInfo()).active === 'Dropped schema');
// close: non-empty asks first; Cancel keeps it
await page.click('.tab.active .tab-close'); await new Promise(r => setTimeout(r, 150));
let dlg = await page.evaluate(() => ({ open: !document.getElementById('modal').hidden, title: document.getElementById('modalTitle').textContent }));
check('closing a tab with content asks first', dlg.open && /Close “Dropped schema”/.test(dlg.title), JSON.stringify(dlg));
await page.keyboard.press('Escape'); await new Promise(r => setTimeout(r, 100));
check('Esc / Cancel keeps the tab', (await tabInfo()).names.length === 5 && (await page.$eval('#modal', el => el.hidden)));
await page.click('.tab.active .tab-close'); await new Promise(r => setTimeout(r, 100));
await page.click('#modalActions .danger'); await new Promise(r => setTimeout(r, 200));
ti = await tabInfo();
check('confirming closes it', ti.names.length === 4 && !ti.names.includes('Dropped schema'), JSON.stringify(ti.names));
// empty tab closes without asking
await page.click('#tabAdd'); await new Promise(r => setTimeout(r, 100));
await page.click('.tab.active .tab-close'); await new Promise(r => setTimeout(r, 150));
check('an empty tab closes without a dialog', (await tabInfo()).names.length === 4 && (await page.$eval('#modal', el => el.hidden)));
// keyboard: arrows move between tabs
await page.focus('.tab.active .tab-btn');
const beforeKey = (await tabInfo()).active;
await page.keyboard.press('ArrowLeft'); await new Promise(r => setTimeout(r, 200));
const afterKey = await tabInfo();
check('Arrow keys switch tabs', afterKey.active !== beforeKey && (await page.evaluate(() => document.activeElement.classList.contains('tab-btn'))), `${beforeKey} -> ${afterKey.active}`);
// example button jumps to its existing tab instead of duplicating
await page.click('.examples-row button[data-ex="pipeline"]'); await new Promise(r => setTimeout(r, 200));
ti = await tabInfo();
check('example button reuses its open tab', ti.active === 'Pipeline example' && ti.names.filter(n => n === 'Pipeline example').length === 1, JSON.stringify(ti.names));
// everything survives a reload
const namesBefore = ti.names;
await page.reload({ waitUntil: 'networkidle0' }); await page.waitForSelector('.tab');
ti = await tabInfo();
check('tabs, active tab, and per-tab state restored after reload', JSON.stringify(ti.names) === JSON.stringify(namesBefore) && ti.active === 'Pipeline example' && ti.tables === 17 && (await posOf('countries')) === tab1Pos, JSON.stringify({ ti, pos: await posOf('countries') }));
await page.screenshot({ path: `${OUT}/e2e_tabs.png` });
// migration from the single-document version
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem('lineage-src', 'Table legacy_t {\n  id int [pk]\n}\n');
  localStorage.setItem('lineage-ui', JSON.stringify({ manualPos: { legacy_t: { x: 500, y: 300 } }, hidden: [], collapsed: [] }));
});
await page.reload({ waitUntil: 'networkidle0' }); await page.waitForSelector('.tab');
ti = await tabInfo();
check('old single-document draft + layout become tab 1', ti.names.length === 1 && /legacy_t/.test(ti.src) && (await posOf('legacy_t')) === '500px,300px', JSON.stringify({ ti, pos: await posOf('legacy_t') }));
await page.evaluate(() => localStorage.clear());

check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors));
await browser.close();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
