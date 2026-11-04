#!/usr/bin/env node
/**
 * Reports which production files are being edited concurrently by more than
 * one open `dream/*` branch, using only local git plumbing (no GitHub API,
 * no model calls) — so it runs even when LLM_EVAL and `gh` are both
 * unavailable. Point of this tool: a nightly Dream Machine run checks
 * mergeability against `main` alone, which stays clean even when 10+ other
 * open branches are independently editing the same file; this surfaces that
 * contention so a candidate file can be chosen (or a human reviewer
 * prioritized) with it in view.
 *
 * Usage: node scripts/dream-cycle-contention.mjs [--base <ref>] [--remote <prefix>] [--threshold N] [--warn-branch <name>]
 * Requires `npm run build` first (imports the compiled logic from dist/).
 */
import { execFileSync } from 'node:child_process';
import {
  computeFileContention,
  contentionWarningsForBranch,
} from '../dist/src/control-plane/tooling/dream-cycle-contention.js';

function parseArgs(argv) {
  const opts = { base: 'origin/main', remote: 'origin/dream/', threshold: 3, warnBranch: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base') opts.base = argv[++i];
    else if (arg === '--remote') opts.remote = argv[++i];
    else if (arg === '--threshold') opts.threshold = Number(argv[++i]);
    else if (arg === '--warn-branch') opts.warnBranch = argv[++i];
  }
  return opts;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function listRemoteBranches(prefix) {
  return git(['branch', '-r'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix));
}

function changedFiles(base, branch) {
  return git(['diff', '--name-only', `${base}...${branch}`, '--', 'src', 'services'])
    .split('\n')
    .filter(Boolean);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const branches = listRemoteBranches(opts.remote);
  if (branches.length === 0) {
    console.log(`No branches found matching prefix '${opts.remote}'.`);
    return;
  }

  const branchFiles = {};
  for (const branch of branches) {
    branchFiles[branch] = changedFiles(opts.base, branch);
  }

  const entries = computeFileContention(branchFiles, { ignore: [/^docs\/dream-cycle\//, /^docs\/adr\//] });

  console.log(`Scanned ${branches.length} branches against ${opts.base}. ${entries.length} contested file(s):\n`);
  for (const entry of entries) {
    console.log(`  ${entry.branches.length}x  ${entry.file}`);
    for (const branch of entry.branches) console.log(`        ${branch}`);
  }

  if (opts.warnBranch) {
    const warnings = contentionWarningsForBranch(entries, opts.warnBranch, opts.threshold);
    if (warnings.length > 0) {
      console.log(`\n${opts.warnBranch} touches ${warnings.length} file(s) already edited by >= ${opts.threshold} other open branches:`);
      for (const w of warnings) console.log(`  ${w.file} (${w.branches.length} branches)`);
      process.exitCode = 1;
    }
  }
}

main();
