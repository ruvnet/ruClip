/**
 * Reconciles `docs/dream-cycle/LEDGER.md` (the Dream Cycle's durable
 * cross-night memory, per `docs/dream-cycle/PROMPT.md` STEP 1) against every
 * unmerged `dream/*` branch's own copy of that file.
 *
 * Finding (2026-09-19, developer-experience): the Dream Cycle's own routine
 * commits each night's ledger row only inside that night's `dream/<date>-*`
 * branch, then opens a draft PR (per its "never self-merge" invariant).
 * Verified against the real repository state: `main`'s `LEDGER.md` has not
 * gained a row since 2026-09-06, yet 9 further nights (2026-09-07 through
 * 2026-09-18) each ran, found something, and pushed a branch — every one of
 * those rows exists only on its own unmerged branch. Every one of those
 * nights' STEP 1 ("read `docs/dream-cycle/LEDGER.md`") therefore saw a
 * ledger stuck at 2026-09-06 and re-derived the same "0 of last N PRs
 * merged" learning signal night after night, blind to 9 nights of
 * accumulated evidence. This module does not fix the merge bottleneck (out
 * of this session's authority — "never merge") — it recovers visibility
 * into the siloed history without merging anything, by reading each
 * branch's own committed copy of the file (`git show <ref>:<path>`) and
 * merging rows deterministically. `LEDGER.md` itself is never rewritten by
 * this module; the output is a separate, regenerable file.
 */

export interface ParsedLedgerTable {
  /** Every line before the first data row (title, blurb, header, separator), verbatim. */
  preambleLines: string[];
  rows: ParsedLedgerRow[];
}

export interface ParsedLedgerRow {
  /** The row's exact source line, unmodified. */
  raw: string;
  /** Trimmed cell text, in column order, with the leading/trailing empty cells from `| ... |` dropped. */
  cells: string[];
  /** `${Date}::${Deep}` — the two columns that uniquely identify a Dream Cycle run. */
  key: string;
}

export interface ReconciledLedgerRow extends ParsedLedgerRow {
  /** `"main"` for a row already on the trunk copy, else the branch name it was recovered from. */
  source: string;
}

export interface ReconcileLedgerResult {
  markdown: string;
  /** Rows recovered from a branch that were absent from `mainMarkdown`, in the order they were merged in. */
  addedRows: Array<{ branch: string; key: string }>;
}

const SEPARATOR_ROW = /^\|[\s:-]+(\|[\s:-]+)*\|?$/;
const HEADER_ROW = /^\|\s*Date\s*\|/i;

function isTableRowLine(line: string): boolean {
  return line.trim().startsWith('|');
}

function splitCells(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((cell) => cell.trim());
}

/**
 * Splits a Dream Cycle ledger's markdown into its preamble (title, blurb,
 * header row, separator row — everything that isn't a data row) and its
 * parsed data rows. Rows are recognized as any `|`-prefixed line after the
 * header/separator pair that isn't itself a separator line.
 */
export function parseLedgerTable(markdown: string): ParsedLedgerTable {
  const lines = markdown.split('\n');
  const preambleLines: string[] = [];
  const rows: ParsedLedgerRow[] = [];
  let pastHeader = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!isTableRowLine(line)) {
      if (!pastHeader) preambleLines.push(line);
      continue;
    }
    if (HEADER_ROW.test(trimmed) || SEPARATOR_ROW.test(trimmed)) {
      preambleLines.push(line);
      if (SEPARATOR_ROW.test(trimmed)) pastHeader = true;
      continue;
    }
    if (!pastHeader) {
      // A `|`-prefixed line before the separator that isn't the header
      // itself shouldn't occur in a well-formed ledger; treat it as
      // preamble rather than guessing at cell structure.
      preambleLines.push(line);
      continue;
    }
    const cells = splitCells(line);
    const date = cells[0] ?? '';
    const deep = cells[1] ?? '';
    rows.push({ raw: line, cells, key: `${date}::${deep}` });
  }

  return { preambleLines, rows };
}

function parseLedgerDate(key: string): number {
  const datePart = key.split('::')[0] ?? '';
  const parsed = Date.parse(datePart);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/**
 * Merges `main`'s ledger with every named branch's own copy, in ascending
 * branch-name order (Dream Cycle branch names are `dream/<YYYY-MM-DD>-...`,
 * so this is also chronological). A row is "recovered" from a branch only
 * if no row with the same `${Date}::${Deep}` key has already been seen —
 * from `main` or an earlier branch in the iteration — so a row that *did*
 * make it to `main` (a merged night) is never duplicated. The merged set is
 * then sorted by date ascending, stable on ties, matching the ledger's own
 * "one row per run, appended only" convention. `main`'s own rows and their
 * relative order are otherwise left untouched.
 */
export function reconcileLedger(
  mainMarkdown: string,
  branchMarkdowns: Record<string, string>,
): ReconcileLedgerResult {
  const main = parseLedgerTable(mainMarkdown);
  const seenKeys = new Set(main.rows.map((row) => row.key));

  const merged: ReconciledLedgerRow[] = main.rows.map((row) => ({ ...row, source: 'main' }));
  const addedRows: Array<{ branch: string; key: string }> = [];

  const branchNames = Object.keys(branchMarkdowns).sort();
  for (const branch of branchNames) {
    const { rows } = parseLedgerTable(branchMarkdowns[branch] ?? '');
    for (const row of rows) {
      if (seenKeys.has(row.key)) continue;
      seenKeys.add(row.key);
      merged.push({ ...row, source: branch });
      addedRows.push({ branch, key: row.key });
    }
  }

  const sorted = merged
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const byDate = parseLedgerDate(a.row.key) - parseLedgerDate(b.row.key);
      return byDate !== 0 ? byDate : a.index - b.index;
    })
    .map(({ row }) => row);

  const markdown = [...main.preambleLines, ...sorted.map((row) => row.raw)].join('\n') + '\n';

  return { markdown, addedRows };
}
