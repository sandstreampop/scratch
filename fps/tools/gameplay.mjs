// Gameplay acceptance suite.
//
//   node tools/gameplay.mjs                  every suite
//   node tools/gameplay.mjs movement weapon  named suites
//   node tools/gameplay.mjs --dist           against the shipped bundle
//   node tools/gameplay.mjs --share          one browser for all suites (fast, leaky)
//   node tools/gameplay.mjs --list           what exists
//
// Each suite is a file `gameplay-<name>.mjs` in this directory exporting
//
//   export const NAME = 'movement';
//   export default async function run(sim, report) { ... }
//
// ---------------------------------------------------------------------------
// Why this runner lints its own suites
//
// The first generation of five suites was audited by an independent critic
// each, and four came back as decoration rather than instrument. The defects
// were not subtle and they were not the agents' invention — they were all
// things the harness allowed. So the harness now refuses them, because a rule
// that is merely written down in a brief is a rule that gets broken at 2 a.m.
// by whoever is closest to a deadline.
//
// Enforced statically, before a suite is allowed to run:
//
//   - `report.check(name, true, …)` with a literal true. 23 of 53 movement
//     checks were this. Perturbing walkSpeed by 32% left the failure set
//     byte-identical, because nearly half the suite could not fail.
//   - Importing from ../src/. Reading a tuning constant to derive the
//     expectation makes both sides of the comparison move together; six
//     movement checks and four AI checks were tautologies of this kind.
//   - A locally-defined target lookup. Every suite wrote its own fuzzy
//     camelCase-to-snake_case matcher and each silently missed: 2 of 20
//     resolved in movement, 0 of 10 in ai, and every miss printed "no sourced
//     target yet" — a false statement about the research. report.against()
//     takes a domain and a key and throws on an unknown one.
//
// Enforced at runtime by the reporter in _sim.mjs: no hand-passed target
// values, no non-finite measurement masquerading as zero, no un-targeted
// quantity counted as a passing check.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSim, makeReporter } from './_sim.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dist = args.includes('--dist');
const list = args.includes('--list');
const share = args.includes('--share');
const wanted = args.filter((a) => !a.startsWith('--'));

let targets = null;
try { targets = await import('./targets.mjs'); } catch (e) {
  console.error(`gameplay: could not load targets.mjs — ${e.message}`);
  process.exit(2);
}

/** Static defects that must stop a suite from running at all. */
function lint(file, src) {
  const bad = [];
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    const n = i + 1;
    if (/^\s*(\/\/|\*)/.test(line)) return;
    // A literal true as the verdict. The whole point of a check is that it can
    // be false.
    if (/\breport\s*\.\s*check\s*\([^;]*,\s*true\s*,/.test(line)) {
      bad.push(`${file}:${n}: report.check(..., true, ...) cannot fail — use report.measure() for an `
        + 'un-targeted quantity, or write a real comparison');
    }
    if (/\breport\s*\.\s*check\s*\([^;]*,\s*false\s*,/.test(line)) {
      bad.push(`${file}:${n}: report.check(..., false, ...) always fails — assert the condition instead`);
    }
    // Reading the game's own tuning to build the expectation.
    if (/from\s+['"]\.\.\/src\//.test(line) || /require\(\s*['"]\.\.\/src\//.test(line)) {
      bad.push(`${file}:${n}: a suite may not import from ../src/ — deriving the expectation from the `
        + 'constant under test makes both sides move together and the check can never disagree');
    }
    // Home-grown target lookups.
    if (/function\s+findTarget|const\s+findTarget\s*=|function\s+lookupTarget/.test(line)) {
      bad.push(`${file}:${n}: no local target lookup — call report.against(name, measured, domain, key), `
        + 'which throws on an unknown key instead of silently reporting "no sourced target"');
    }
  });
  return bad;
}

const files = fs.readdirSync(HERE)
  .filter((f) => f.startsWith('gameplay-') && f.endsWith('.mjs'))
  .sort();

const suites = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(HERE, f), 'utf8');
  const mod = await import(path.join(HERE, f));
  const name = mod.NAME ?? f.replace(/^gameplay-|\.mjs$/g, '');
  if (typeof mod.default !== 'function') {
    console.error(`${f}: no default export — a suite must export default async (sim, report) => {}`);
    process.exit(1);
  }
  suites.push({ name, file: f, run: mod.default, lint: lint(f, src) });
}

if (list) {
  for (const s of suites) console.log(`${s.name.padEnd(14)} ${s.file}${s.lint.length ? `  (${s.lint.length} lint errors)` : ''}`);
  process.exit(0);
}

const selected = wanted.length ? suites.filter((s) => wanted.includes(s.name)) : suites;
if (!selected.length) {
  console.error(`gameplay: nothing matched ${wanted.join(', ')}. Known: ${suites.map((s) => s.name).join(', ')}`);
  process.exit(1);
}

const linted = selected.flatMap((s) => s.lint);
if (linted.length) {
  console.error('gameplay: suites rejected before running —\n');
  for (const l of linted) console.error(`  ${l}`);
  console.error(`\n${linted.length} static defect(s). These are the patterns that made the first `
    + 'generation of suites unfalsifiable; fix them rather than working around the linter.');
  process.exit(1);
}

const results = [];
let hardFailure = null;
// One browser per suite by default. A suite was found monkey-patching
// g.vfx.impact without tearing it down, which silently changes what every later
// suite measures — and a shared-state bug between instruments is the hardest
// kind of wrong number to track down. --share opts back into the fast path.
let shared = null;
try {
  if (share) shared = await openSim({ dist });

  for (const s of selected) {
    console.log(`\n──── ${s.name} ${'─'.repeat(Math.max(0, 60 - s.name.length))}`);
    const sim = shared ?? await openSim({ dist });
    const report = makeReporter(s.name, { targets });
    const before = sim.errors.length;
    try {
      await s.run(sim, report);
    } catch (e) {
      report.rows.push({
        kind: 'check', name: `${s.name} suite completed`, ok: false,
        detail: `threw: ${String(e.message ?? e).slice(0, 400)}`,
      });
      console.log(`FAIL  ${s.name} suite completed  — threw: ${String(e.message ?? e).slice(0, 400)}`);
    }
    const checks = report.rows.filter((r) => r.kind === 'check');
    if (checks.length === 0) {
      report.rows.push({
        kind: 'check', name: `${s.name} produced assertions`, ok: false,
        detail: '0 checks — a suite that asserts nothing is indistinguishable from a broken instrument',
      });
    }
    const raised = sim.errors.slice(before);
    if (raised.length) {
      report.rows.push({
        kind: 'check', name: `${s.name} ran without page errors`, ok: false,
        detail: `${raised.length} page error(s): ${raised[0]}`,
      });
    }
    report.finish();
    if (!shared) await sim.close();
    const final = report.rows.filter((r) => r.kind === 'check');
    results.push({
      name: s.name,
      passed: final.filter((r) => r.ok).length,
      total: final.length,
      measures: report.rows.filter((r) => r.kind === 'measure').length,
      rows: report.rows,
    });
  }
} catch (e) {
  hardFailure = e;
} finally {
  if (shared) await shared.close();
}

if (hardFailure) {
  console.error(`\ngameplay: harness failure — ${hardFailure.stack ?? hardFailure}`);
  process.exit(2);
}

console.log(`\n${'='.repeat(66)}`);
let total = 0, passed = 0, measures = 0;
for (const r of results) {
  total += r.total; passed += r.passed; measures += r.measures;
  console.log(`${r.passed === r.total ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(14)} ${r.passed}/${r.total}`
    + `${r.measures ? `  (+${r.measures} untargeted)` : ''}`);
  for (const b of r.rows.filter((x) => x.kind === 'check' && !x.ok)) {
    console.log(`        ${b.name}  — ${b.detail}`);
  }
}
console.log(`${'='.repeat(66)}`);
console.log(`gameplay: ${passed}/${total} checks passed across ${results.length} suites`
  + `${measures ? `, plus ${measures} measurements with no sourced target` : ''}`);
const uncovered = targets.missing?.() ?? [];
if (uncovered.length) {
  console.log(`targets.mjs has no reference value for: ${uncovered.join(', ')}`);
}
process.exit(passed === total ? 0 : 1);
