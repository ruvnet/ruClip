#!/usr/bin/env node
/**
 * Reproducible entry point for the Dream Machine's nightly ledger-check
 * step: turns a JSON snapshot of `dream/*` PR state (as returned by
 * `GET /repos/{owner}/{repo}/pulls?state=all`, filtered to `head.ref`
 * starting with `dream/`) into the merge-rate summary this repo's own
 * ledger (docs/dream-cycle/LEDGER.md) has had no mechanical way to compute
 * since night 1 — see docs/dream-cycle/2026-10-22-architecture-report.md.
 *
 * Usage:
 *   npm run build
 *   node scripts/dream-cycle-ledger-report.mjs docs/dream-cycle/pr-backlog-snapshot-2026-10-22.json
 */
import { readFileSync } from 'node:fs';
import { summarizeDreamCyclePrs } from '../dist/src/control-plane/dream-cycle/pr-backlog-stats.js';

const snapshotPath = process.argv[2];
if (!snapshotPath) {
  console.error('usage: dream-cycle-ledger-report.mjs <snapshot.json>');
  process.exit(1);
}

const raw = JSON.parse(readFileSync(snapshotPath, 'utf8'));
const prs = raw.map((pr) => ({
  number: pr.number,
  headRef: pr.headRef,
  state: pr.state,
  merged: pr.merged,
  createdAt: pr.createdAt,
}));

const summary = summarizeDreamCyclePrs(prs);
console.log(JSON.stringify(summary, null, 2));
