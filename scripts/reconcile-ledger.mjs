#!/usr/bin/env node
/**
 * Recovers Dream Cycle ledger rows siloed on unmerged `dream/*` branches
 * (see `src/control-plane/dream-cycle/reconcile-ledger.ts` for the finding
 * and the merge logic this wraps) and writes them, merged with `main`'s own
 * `docs/dream-cycle/LEDGER.md`, to `docs/dream-cycle/LEDGER.reconciled.md`.
 *
 * `LEDGER.md` itself is never modified — it stays the append-only source of
 * truth the routine's own convention expects. This is a read-only recovery
 * view, safe to regenerate any time; a branch this repo has no network
 * access to, or that has been deleted/merged/rebased away, is silently
 * skipped rather than failing the run (best-effort recovery, not a gate).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { reconcileLedger } from '../dist/src/control-plane/dream-cycle/reconcile-ledger.js';

const LEDGER_PATH = 'docs/dream-cycle/LEDGER.md';
const OUT_PATH = 'docs/dream-cycle/LEDGER.reconciled.md';
const BRANCH_GLOB = 'dream/*';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function fetchDreamBranches() {
  try {
    git(['fetch', 'origin', `+refs/heads/${BRANCH_GLOB}:refs/remotes/origin/${BRANCH_GLOB}`]);
  } catch (err) {
    console.error(`warning: git fetch origin failed (${err.message}) — reconciling against locally-known refs only`);
  }
}

function listRemoteDreamBranches() {
  let out;
  try {
    out = git(['branch', '-r', '--list', `origin/${BRANCH_GLOB}`]);
  } catch (err) {
    console.error(`warning: could not list remote branches (${err.message})`);
    return [];
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function readLedgerAtRef(ref) {
  try {
    return git(['show', `${ref}:${LEDGER_PATH}`]);
  } catch {
    return null; // branch has no ledger file, or ref is gone — skip, don't fail the run
  }
}

function main() {
  const mainMarkdown = readFileSync(LEDGER_PATH, 'utf8');

  fetchDreamBranches();
  const refs = listRemoteDreamBranches();

  const branchMarkdowns = {};
  for (const ref of refs) {
    const name = ref.replace(/^origin\//, '');
    const content = readLedgerAtRef(ref);
    if (content !== null) branchMarkdowns[name] = content;
  }

  const { markdown, addedRows } = reconcileLedger(mainMarkdown, branchMarkdowns);
  writeFileSync(OUT_PATH, markdown);

  console.log(
    `Scanned ${refs.length} remote dream/* branch(es); recovered ${addedRows.length} row(s) not present on main.`,
  );
  for (const { branch, key } of addedRows) {
    console.log(`  + ${key}  (from ${branch})`);
  }
  console.log(`Wrote ${OUT_PATH} (${LEDGER_PATH} itself was not modified).`);
}

main();
