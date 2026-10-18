#!/usr/bin/env node
/**
 * Dream Cycle developer-experience tool (2026-10-18 night). Live, git-only
 * companion to `supersession-audit.ts` (PR #72, unmerged): where that tool
 * only catches a duplicate `dream/*` branch pair when the later one's own
 * commit text names the earlier PR number, this one catches the pairs
 * that never say so out loud — any two branches whose diffs (against their
 * own merge-base with `main`) touch overlapping lines of the same file.
 *
 * Read-only against git: every invocation uses `execFileSync` with a
 * static argv array (branch names, sourced only from `git for-each-ref`'s
 * own output, are passed as inert array elements, never interpolated into
 * a shell string). Best-effort `git fetch`; never fails the caller if the
 * network/remote is unavailable. Writes one local report file and always
 * exits 0 — this is an advisory tool, never a CI gate.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { findOverlappingPairs, formatOverlapReport } from '../dist/src/control-plane/dream-cycle/overlap-duplicate-audit.js';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

try {
  git(['fetch', 'origin', '+refs/heads/dream/*:refs/remotes/origin/dream/*']);
} catch (err) {
  console.error(`dream-overlap-audit: best-effort fetch failed, using whatever refs are already local (${err.message})`);
}

let branchNames;
try {
  branchNames = git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/dream/'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
} catch (err) {
  console.error(`dream-overlap-audit: could not list dream/* branches (${err.message})`);
  branchNames = [];
}

const branchDiffs = new Map();
for (const ref of branchNames) {
  const shortName = ref.replace(/^origin\//, '');
  try {
    const base = git(['merge-base', 'main', ref]).trim();
    const diffText = git(['diff', base, ref]);
    branchDiffs.set(shortName, diffText);
  } catch (err) {
    console.error(`dream-overlap-audit: skipping ${shortName} (${err.message})`);
  }
}

const matches = findOverlappingPairs(branchDiffs);
const report = [
  '# Dream Cycle overlap-duplicate audit',
  '',
  `Scanned ${branchDiffs.size} \`dream/*\` branch(es) against their own merge-base with \`main\`.`,
  '',
  'This is a weaker, noisier signal than `supersession-audit.ts`\'s textual',
  'self-admission check (PR #72) — a shared file/line region does not prove',
  'one branch supersedes the other. Nothing listed here is auto-closed;',
  'every match is a human-triage recommendation only.',
  '',
  formatOverlapReport(matches),
].join('\n');

writeFileSync('docs/dream-cycle/OVERLAP-AUDIT.md', report);
console.log(report);
process.exitCode = 0;
