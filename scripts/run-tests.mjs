#!/usr/bin/env node
/**
 * Portable replacement for `node --test --test-reporter=spec "dist/**\/*.test.js"`.
 *
 * That quoted-glob form only works because Node 22+'s `--test` runner
 * expands glob patterns itself; on Node 20 it treats the quoted string as a
 * literal filename and fails with "Could not find 'dist/**\/*.test.js'".
 * Confirmed by actually running it under both versions (`nvm use 20`), not
 * assumed. An unquoted glob would let the invoking shell expand it instead,
 * but that depends on which shell runs npm scripts (dash doesn't support
 * `**`) — fragile in CI. This script walks the filesystem itself, with no
 * dependency on either Node's glob support or the shell's, and passes an
 * explicit file list to `node --test`.
 *
 * Recurses through the entire root (matching the original `dist/**` scope
 * exactly, not just `dist/tests/`) — dist/src/control-plane/**\/*.test.js
 * (coder-stage colocated tests) and dist/tests/**\/*.test.js (independent
 * test-stage coverage) both exist and both must run; narrowing the walk
 * would silently drop real, already-passing tests from the suite.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.argv[2] ?? 'dist';

function collectTestFiles(dir) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
    } else if (entry.endsWith('.test.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

const testFiles = collectTestFiles(root).sort();

if (testFiles.length === 0) {
  console.error(`No *.test.js files found under '${root}' — did the build run first?`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...testFiles], {
  stdio: 'inherit',
});

// Propagate the child's exact exit code — a genuinely failing test must
// still fail this script, not be silently swallowed. spawnSync's own status
// is null only if the process was killed by a signal, not on a normal
// nonzero exit.
process.exit(result.status ?? 1);
