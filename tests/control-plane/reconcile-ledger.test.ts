/**
 * Coverage for the 2026-09-19 developer-experience finding: `main`'s
 * `docs/dream-cycle/LEDGER.md` has been stuck at 2026-09-06 for 9 further
 * Dream Cycle nights because each night's ledger row is committed only to
 * that night's own unmerged `dream/*` branch. These tests exercise
 * `reconcileLedger`'s merge/dedupe/ordering logic against small fixture
 * tables (not live git state, so the suite stays deterministic) rather than
 * the real repository content, which changes every night.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLedgerTable, reconcileLedger } from '../../src/control-plane/dream-cycle/reconcile-ledger.js';

const HEADER = [
  '# Dream Cycle Ledger',
  '',
  'One row per run, appended only, never rewritten.',
  '',
  '| Date | Deep | Finding | Issue | PR | Evaluated? | Verdict | Effect | Witness | Prior-night fates |',
  '|---|---|---|---|---|---|---|---|---|---|',
].join('\n');

function ledger(...rows: string[]): string {
  return [HEADER, ...rows].join('\n') + '\n';
}

const ROW_0902 = '| 2026-09-02 | architecture | finding A | [#8](x) | [#9](x) | yes | ACCEPT | effect A | hashA | n/a |';
const ROW_0906 = '| 2026-09-06 | security | finding B | [#14](x) | [#15](x) | yes | ACCEPT | effect B | hashB | fates B |';
const ROW_0907 = '| 2026-09-07 | architecture | finding C | [#16](x) | [#17](x) | yes | ACCEPT | effect C | hashC | fates C |';
const ROW_0908 = '| 2026-09-08 | performance | finding D | [#18](x) | [#19](x) | yes | ACCEPT | effect D | hashD | fates D |';

test('parseLedgerTable extracts preamble verbatim and rows with a Date::Deep key', () => {
  const parsed = parseLedgerTable(ledger(ROW_0902, ROW_0906));
  assert.equal(parsed.preambleLines.join('\n'), HEADER);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0]!.key, '2026-09-02::architecture');
  assert.equal(parsed.rows[0]!.raw, ROW_0902);
  assert.equal(parsed.rows[1]!.key, '2026-09-06::security');
});

test('reconcileLedger recovers rows from unmerged branches that are absent from main, in date order', () => {
  const main = ledger(ROW_0902, ROW_0906);
  const branches = {
    'dream/2026-09-07-architecture': ledger(ROW_0902, ROW_0906, ROW_0907),
    'dream/2026-09-08-performance': ledger(ROW_0902, ROW_0906, ROW_0908),
  };

  const { markdown, addedRows } = reconcileLedger(main, branches);
  const { rows } = parseLedgerTable(markdown);

  assert.deepEqual(
    rows.map((r) => r.key),
    ['2026-09-02::architecture', '2026-09-06::security', '2026-09-07::architecture', '2026-09-08::performance'],
  );
  assert.deepEqual(
    addedRows,
    [
      { branch: 'dream/2026-09-07-architecture', key: '2026-09-07::architecture' },
      { branch: 'dream/2026-09-08-performance', key: '2026-09-08::performance' },
    ],
  );
});

test('reconcileLedger never duplicates a row that already landed on main (a merged night)', () => {
  // Simulates the one case that SHOULD be a no-op: a night whose PR was
  // actually merged, so main already carries its row directly (not via
  // this recovery path) — the same row also still exists on the now-stale
  // branch ref, and must not be double-counted.
  const main = ledger(ROW_0902, ROW_0906, ROW_0907);
  const branches = { 'dream/2026-09-07-architecture': ledger(ROW_0902, ROW_0906, ROW_0907) };

  const { markdown, addedRows } = reconcileLedger(main, branches);
  const { rows } = parseLedgerTable(markdown);

  assert.equal(addedRows.length, 0);
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((r) => r.key === '2026-09-07::architecture').length, 1);
});

test('reconcileLedger keeps a duplicate finding for the same Date but a different Deep surface (distinct key)', () => {
  // The real ledger has exactly this case: two 2026-09-03 rows (one with a
  // real issue/PR, one a same-night LOCAL fallback entry) share a date but
  // have the same Deep ("performance") too, so a real ledger never needs
  // two distinct rows for one Date::Deep pair from different branches —
  // this documents that reconcileLedger's key is Date+Deep, not Date alone,
  // by using two different Deep values on the same date.
  const rowA = '| 2026-09-10 | correctness | finding E | [#22](x) | [#23](x) | yes | ACCEPT | effect E | hashE | fates E |';
  const rowB = '| 2026-09-10 | performance | finding F | [#22](x) | [#23](x) | yes | ACCEPT | effect F | hashF | fates F |';
  const main = ledger(rowA);
  const branches = { 'dream/2026-09-10-correctness': ledger(rowA, rowB) };

  const { addedRows } = reconcileLedger(main, branches);

  assert.deepEqual(addedRows, [{ branch: 'dream/2026-09-10-correctness', key: '2026-09-10::performance' }]);
});

test('reconcileLedger preserves main rows and their raw text exactly when no branches recover anything', () => {
  const main = ledger(ROW_0902, ROW_0906);
  const { markdown, addedRows } = reconcileLedger(main, {});
  assert.equal(addedRows.length, 0);
  assert.equal(markdown, main);
});

test('reconcileLedger sorts recovered rows in ascending date order even when branches are visited out of chronological order', () => {
  const main = ledger();
  const branches = {
    'dream/2026-09-08-performance': ledger(ROW_0908),
    'dream/2026-09-02-architecture': ledger(ROW_0902),
    'dream/2026-09-07-architecture': ledger(ROW_0907),
  };

  const { markdown } = reconcileLedger(main, branches);
  const { rows } = parseLedgerTable(markdown);

  assert.deepEqual(rows.map((r) => r.key), [
    '2026-09-02::architecture',
    '2026-09-07::architecture',
    '2026-09-08::performance',
  ]);
});
