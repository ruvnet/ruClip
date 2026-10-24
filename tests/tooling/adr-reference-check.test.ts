/**
 * Coverage for src/tooling/adr-reference-check.ts — synthetic cases first,
 * then a live scan of this repo's own src/services/docs/.github trees
 * (the actual evaluator the dream-cycle 2026-10-24 candidate was measured
 * against; see docs/dream-cycle/2026-10-24-developer-experience-report.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  adrIdFromFilename,
  checkAdrReferences,
  findAdrMentions,
  EXTERNAL_ADR_IDS,
} from '../../src/tooling/adr-reference-check.js';

test('findAdrMentions normalizes 3- and 4-digit forms to the same id', () => {
  const mentions = findAdrMentions('f.md', 'see ADR-076 and ADR-0076 and ADR-0001');
  assert.deepEqual(
    mentions.map((m) => m.adrId),
    ['ADR-76', 'ADR-76', 'ADR-1'],
  );
});

test('checkAdrReferences flags an internal citation with no matching docs/adr/ file', () => {
  const files = [{ path: 'ci.yml', content: "fails fast per ADR-076's anti-gaming intent" }];
  const report = checkAdrReferences(files, new Set(['ADR-1']), new Set());
  assert.equal(report.ok, false);
  assert.equal(report.brokenInternalMentions.length, 1);
  assert.equal(report.brokenInternalMentions[0]?.adrId, 'ADR-76');
});

test('checkAdrReferences passes once the ADR file exists', () => {
  const files = [{ path: 'ci.yml', content: "fails fast per ADR-0002's anti-gaming intent" }];
  const report = checkAdrReferences(files, new Set(['ADR-2']), new Set());
  assert.equal(report.ok, true);
  assert.equal(report.brokenInternalMentions.length, 0);
});

test('checkAdrReferences skips allowlisted external citations even without a local file', () => {
  const files = [{ path: 'x.ts', content: "agentdb-tools.ts's ADR-130 VALID_DOMAINS set" }];
  const report = checkAdrReferences(files, new Set(), new Set(['ADR-130']));
  assert.equal(report.ok, true);
  assert.equal(report.internalMentions.length, 0);
  assert.equal(report.externalMentionsSkipped.length, 1);
});

test('adrIdFromFilename parses the repo\'s own ADR-NNNN-slug.md naming', () => {
  assert.equal(adrIdFromFilename('ADR-0001-ruclip-control-plane.md'), 'ADR-1');
  assert.equal(adrIdFromFilename('README.md'), null);
});

test('LIVE: this repo\'s own src/services/docs/.github trees have no broken internal ADR citations', () => {
  const root = process.cwd();
  const skipDirs = new Set(['node_modules', 'dist', '.git']);
  const extensions = new Set(['.ts', '.md', '.yml', '.yaml']);
  // docs/dream-cycle/ is an append-only historical log (see
  // scripts/check-adr-refs.mjs's matching exclusion for why) — out of
  // scope for this check.
  const skipRelativePrefixes = ['docs/dream-cycle'];

  function walk(dir: string): string[] {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    const files: string[] = [];
    for (const entry of entries) {
      if (skipDirs.has(entry)) continue;
      const fullPath = join(dir, entry);
      if (skipRelativePrefixes.some((p) => relative(root, fullPath).startsWith(p))) continue;
      if (statSync(fullPath).isDirectory()) {
        files.push(...walk(fullPath));
      } else if (extensions.has(entry.slice(entry.lastIndexOf('.')))) {
        files.push(fullPath);
      }
    }
    return files;
  }

  const files = ['src', 'services', 'docs', '.github']
    .flatMap((dir) => walk(join(root, dir)))
    .map((path) => ({ path: relative(root, path), content: readFileSync(path, 'utf8') }));

  const existingAdrIds = new Set(
    readdirSync(join(root, 'docs/adr'))
      .map(adrIdFromFilename)
      .filter((id): id is string => id !== null),
  );

  const report = checkAdrReferences(files, existingAdrIds);

  assert.deepEqual(
    report.brokenInternalMentions.map((m) => `${m.adrId} ${m.file}:${m.line}`),
    [],
    `every ADR-NNN citation not in EXTERNAL_ADR_IDS (${EXTERNAL_ADR_IDS.size} entries) must resolve to a real docs/adr/ file`,
  );
});
