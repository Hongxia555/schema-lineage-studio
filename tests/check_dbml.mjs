// Check a .dbml file two ways:
//   1. dbdiagram compatibility — parse it with the official @dbml/core (what dbdiagram.io runs)
//   2. our tool reads it the same — compare tables / columns / settings / groups / enums /
//      relationships / lineage edges from our in-page parser against the official result
// Usage:  node tests/check_dbml.mjs examples/dbml_reference.dbml
// One-time setup (outside Drive so node_modules never syncs):
//   mkdir -p ~/.schema_lineage_tool && cd ~/.schema_lineage_tool && npm init -y && npm i @dbml/core
import { createRequire } from 'module';
import os from 'os';
import fs from 'fs';
import vm from 'vm';
const require = createRequire(os.homedir() + '/.schema_lineage_tool/');
const { Parser } = require('@dbml/core');

// our parser, taken straight from the tool's source so the check can never drift from it
const html = fs.readFileSync(new URL('../web/schema_lineage_studio.html', import.meta.url), 'utf8');
const code = html.slice(html.indexOf('// ---------- DBML parser'), html.indexOf('// ---------- Display graph'));
const ctx = {}; vm.createContext(ctx); vm.runInContext(code + '\nthis.parseSchema = parseSchema;', ctx);
const { parseSchema } = ctx;

const file = process.argv[2];
if(!file){ console.error('usage: node tests/check_dbml.mjs <file.dbml>'); process.exit(2); }
const src = fs.readFileSync(file, 'utf8');

let off;
try { off = Parser.parse(src, 'dbmlv2'); console.log('PASS valid DBML (dbdiagram.io will accept it)'); }
catch(e){
  console.log('FAIL not valid DBML — dbdiagram.io would reject it:');
  (e.diags || [e]).forEach(d => console.log('   ', d.location ? `line ${d.location.start.line}:${d.location.start.column}` : '', d.message || String(d)));
  process.exit(1);
}


const ours = parseSchema(src);
let fails = 0;
const ok = (name, cond, detail = '') => { if(!cond) fails++; console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : detail); };
const key = (schema, table) => schema === 'public' ? table : `${schema}.${table}`;

// tables + columns (order matters: partial injection must land in the right place)
const offTables = new Map();
off.schemas.forEach(s => s.tables.forEach(t => offTables.set(key(s.name, t.name), t)));
ok('same table set', [...offTables.keys()].sort().join() === [...ours.tables.keys()].sort().join(),
   `official=${[...offTables.keys()].sort()} ours=${[...ours.tables.keys()].sort()}`);
offTables.forEach((t, k) => {
  const o = ours.tables.get(k); if(!o) return;
  const a = t.fields.map(f => f.name).join(','), b = o.fields.map(f => f.name).join(',');
  ok(`columns of ${k}`, a === b, `official=[${a}] ours=[${b}]`);
  // per-column settings
  t.fields.forEach(f => {
    const g = o.fields.find(x => x.name === f.name); if(!g) return;
    const want = { pk: !!f.pk, notNull: !!f.not_null, unique: !!f.unique, increment: !!f.increment, note: (f.note || '').trimEnd() || null };
    const got = { pk: g.pk, notNull: g.notNull, unique: g.unique, increment: g.increment, note: g.note };
    const same = Object.keys(want).every(x => (want[x] || null) === (got[x] || null));
    if(!same) ok(`settings of ${k}.${f.name}`, false, `official=${JSON.stringify(want)} ours=${JSON.stringify(got)}`);
  });
  ok(`note of ${k}`, ((t.note || '').trimEnd() || null) === (o.note || null), `official=${JSON.stringify(t.note)} ours=${JSON.stringify(o.note)}`);
  ok(`index count of ${k}`, (t.indexes || []).length === o.indexes.length, `official=${(t.indexes||[]).length} ours=${o.indexes.length}`);
  if(t.headerColor || o.headercolor) ok(`headercolor of ${k}`, (t.headerColor || '').toLowerCase() === (o.headercolor || '').toLowerCase(), `${t.headerColor} vs ${o.headercolor}`);
  if(t.alias || o.alias) ok(`alias of ${k}`, t.alias === o.alias, `${t.alias} vs ${o.alias}`);
});

// groups
off.schemas.forEach(s => (s.tableGroups || []).forEach(g => g.tables.forEach(t => {
  const k = key(t.schema ? t.schema.name : s.name, t.name);
  ok(`group of ${k}`, ours.tables.get(k)?.group === g.name, `official=${g.name} ours=${ours.tables.get(k)?.group}`);
})));

// enums
const offEnums = [];
off.schemas.forEach(s => s.enums.forEach(e => offEnums.push(key(s.name, e.name) + ':' + e.values.map(v => v.name).join('|'))));
const ourEnums = [...ours.enums].map(([k, v]) => k + ':' + v.map(x => x.value).join('|'));
ok('same enums + values', offEnums.sort().join() === ourEnums.sort().join(), `official=${offEnums} ours=${ourEnums}`);

// relationships: official counts a composite FK once; ours splits it into column pairs
const offRefs = [];
off.schemas.forEach(s => s.refs.forEach(r => {
  const [a, b] = r.endpoints;
  const ta = key(a.schemaName || 'public', a.tableName), tb = key(b.schemaName || 'public', b.tableName);
  a.fieldNames.forEach((f, i) => offRefs.push(`${ta}.${f}~${tb}.${b.fieldNames[i]}`));
}));
const norm = s => s.split('~').sort().join('~');
const ourRefs = ours.refs.map(r => `${r.fromT}.${r.fromF}~${r.toT}.${r.toF}`);
ok('same relationships (column pairs)', offRefs.map(norm).sort().join() === ourRefs.map(norm).sort().join(),
   `\n  official only: ${offRefs.map(norm).filter(x => !ourRefs.map(norm).includes(x))}\n  ours only: ${ourRefs.map(norm).filter(x => !offRefs.map(norm).includes(x))}`);

// lineage edges
const offDeps = [];
off.schemas.forEach(s => s.deps.forEach(d => d.edges.forEach(e => {
  const up = key(e.upstream.schemaName || 'public', e.upstream.tableName), dn = key(e.downstream.schemaName || 'public', e.downstream.tableName);
  const uf = e.upstream.fieldNames && e.upstream.fieldNames.length ? e.upstream.fieldNames : [null];
  const df = e.downstream.fieldNames && e.downstream.fieldNames.length ? e.downstream.fieldNames : [null];
  offDeps.push(`${up}.${uf[0] || '*'}>${dn}.${df[0] || '*'}`);
})));
const ourDeps = ours.deps.map(d => `${d.fromT}.${d.fromF || '*'}>${d.toT}.${d.toF || '*'}`);
ok(`same lineage edges (${offDeps.length})`, offDeps.sort().join() === ourDeps.sort().join(),
   `\n  official only: ${offDeps.filter(x => !ourDeps.includes(x))}\n  ours only: ${ourDeps.filter(x => !offDeps.includes(x))}`);

ok('our parser reports no errors', ours.errors.length === 0, JSON.stringify(ours.errors));
console.log(`\nproject=${JSON.stringify(ours.project && { name: ours.project.name, db: ours.project.databaseType })} stickies=${ours.stickies.length} tables=${ours.tables.size} refs=${ours.refs.length} deps=${ours.deps.length}`);
console.log(fails ? `${fails} FAILED` : 'ALL MATCH');
process.exit(fails ? 1 : 0);
