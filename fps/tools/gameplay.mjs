// Gameplay acceptance suite.
//
//   node tools/gameplay.mjs                  every suite
//   node tools/gameplay.mjs movement weapon  named suites
//   node tools/gameplay.mjs --dist           against the shipped bundle
//   node tools/gameplay.mjs --list           what exists
//
// Each suite is a file `gameplay-<name>.mjs` in this directory exporting
//
//   export const NAME = 'movement';
//   export default async function run(sim, report) { ... }
//
// and is handed an already-booted sim (tools/_sim.mjs) plus a reporter. Suites
// share one browser: booting costs ~15 s of procedural generation and five
// suites paying that separately is the difference between a suite that gets run
// on every change and one that does not.
//
// A suite that measures nothing passes trivially, so the runner requires every
// suite to produce at least one check and treats an empty suite as a failure.
// That is the same defect as a broken instrument returning silence.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSim, makeReporter } from './_sim.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dist = args.includes('--dist');
const list = args.includes('--list');
const wanted = args.filter((a) => !a.startsWith('--'));

const files = fs.readdirSync(HERE)
  .filter((f) => f.startsWith('gameplay-') && f.endsWith('.mjs'))
  .sort();

const suites = [];
for (const f of files) {
  const mod = await import(path.join(HERE, f));
  const name = mod.NAME ?? f.replace(/^gameplay-|\.mjs$/g, '');
  if (typeof mod.default !== 'function') {
    console.error(`${f}: no default export — a suite must export default async (sim, report) => {}`);
    process.exit(1);
  }
  suites.push({ name, file: f, run: mod.default });
}

if (list) {
  for (const s of suites) console.log(`${s.name.padEnd(14)} ${s.file}`);
  process.exit(0);
}

const selected = wanted.length ? suites.filter((s) => wanted.includes(s.name)) : suites;
if (!selected.length) {
  console.error(`gameplay: nothing matched ${wanted.join(', ')}. Known: ${suites.map((s) => s.name).join(', ')}`);
  process.exit(1);
}

const sim = await openSim({ dist });
const results = [];
let hardFailure = null;

try {
  for (const s of selected) {
    console.log(`\n──── ${s.name} ${'─'.repeat(Math.max(0, 60 - s.name.length))}`);
    const report = makeReporter(s.name);
    const before = sim.errors.length;
    try {
      await s.run(sim, report);
    } catch (e) {
      report.check(`${s.name} suite completed`, false, `threw: ${String(e).slice(0, 300)}`);
    }
    // A suite is not allowed to be quietly empty.
    if (report.rows.length === 0) {
      report.check(`${s.name} produced measurements`, false,
        'the suite ran and asserted nothing, which is indistinguishable from a broken instrument');
    }
    // Page errors raised during a suite belong to that suite.
    const raised = sim.errors.slice(before);
    if (raised.length) {
      report.check(`${s.name} ran without page errors`, false, raised[0]);
    }
    const passed = report.rows.filter((r) => r.ok).length;
    results.push({ name: s.name, passed, total: report.rows.length, rows: report.rows });
  }
} catch (e) {
  hardFailure = e;
} finally {
  await sim.close();
}

if (hardFailure) {
  console.error(`\ngameplay: harness failure — ${hardFailure}`);
  process.exit(2);
}

console.log(`\n${'='.repeat(66)}`);
let total = 0, passed = 0;
for (const r of results) {
  total += r.total; passed += r.passed;
  const bad = r.rows.filter((x) => !x.ok);
  console.log(`${r.passed === r.total ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(14)} ${r.passed}/${r.total}`);
  for (const b of bad) console.log(`        ${b.name}  — ${b.detail}`);
}
console.log(`${'='.repeat(66)}`);
console.log(`gameplay: ${passed}/${total} checks passed across ${results.length} suites`);
process.exit(passed === total ? 0 : 1);
