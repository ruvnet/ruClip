#!/usr/bin/env node
/**
 * Thin CLI wrapper around dist/src/tooling/adr-reference-check.js — walks
 * the repo's own source/docs for ADR-NNN citations and reports any that
 * don't resolve to a real docs/adr/ file or a known external allowlist
 * entry. Read-only filesystem access only (no exec/eval/network). Wired as
 * an advisory CI step (continue-on-error) — see .github/workflows/ci.yml.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  adrIdFromFilename,
  checkAdrReferences,
  formatReport,
} from '../dist/src/tooling/adr-reference-check.js';

const ROOT = new URL('..', import.meta.url).pathname;
const SCAN_DIRS = ['src', 'services', 'docs', '.github'];
const SCAN_EXTENSIONS = new Set(['.ts', '.md', '.yml', '.yaml']);
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', '.git']);
// docs/dream-cycle/ is an append-only historical log (nightly reports,
// LEDGER.md) that legitimately quotes past states verbatim, including
// citations that were dangling (or not yet created) at the time a given
// night ran — it is not living documentation whose ADR-NNN citations must
// stay resolvable, so it's out of scope for this check.
const SKIP_RELATIVE_PREFIXES = ['docs/dream-cycle'];

function walk(dir) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry)) continue;
    const fullPath = join(dir, entry);
    if (SKIP_RELATIVE_PREFIXES.some((p) => relative(ROOT, fullPath).startsWith(p))) continue;
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (SCAN_EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) {
      files.push(fullPath);
    }
  }
  return files;
}

function readSourceFiles() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    for (const path of walk(join(ROOT, dir))) {
      files.push({
        path: relative(ROOT, path),
        content: readFileSync(path, 'utf8'),
      });
    }
  }
  return files;
}

function readExistingAdrIds() {
  const ids = new Set();
  let entries;
  try {
    entries = readdirSync(join(ROOT, 'docs/adr'));
  } catch {
    return ids;
  }
  for (const entry of entries) {
    const id = adrIdFromFilename(entry);
    if (id) ids.add(id);
  }
  return ids;
}

const files = readSourceFiles();
const existingAdrIds = readExistingAdrIds();
const report = checkAdrReferences(files, existingAdrIds);

console.log(formatReport(report));
process.exit(report.ok ? 0 : 1);
