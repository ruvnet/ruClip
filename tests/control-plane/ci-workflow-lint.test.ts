import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findUnsafeFallbackSteps } from '../../src/control-plane/dream-cycle/ci-workflow-lint.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Compiled location is dist/tests/control-plane/*.test.js; the repo root
// (and the real .github/ this test reads) is three levels up from there.
const REPO_ROOT = join(__dirname, '..', '..', '..');
const CI_WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

test('findUnsafeFallbackSteps flags a guarded command suffixed with || true', () => {
  const yaml = [
    'jobs:',
    '  scaffold-check:',
    '    steps:',
    '      - run: npm install --no-audit --no-fund || true',
    '      - run: npm run build',
    '      - run: npm test',
  ].join('\n');

  const flagged = findUnsafeFallbackSteps(yaml);

  assert.equal(flagged.length, 1);
  assert.equal(flagged[0]?.line, 4);
  assert.match(flagged[0]?.command ?? '', /npm install/);
});

test('findUnsafeFallbackSteps ignores a guarded command with no unsafe fallback', () => {
  const yaml = ['      - run: npm run build', '      - run: npm test'].join('\n');

  assert.deepEqual(findUnsafeFallbackSteps(yaml), []);
});

test('findUnsafeFallbackSteps ignores || true on a command it does not guard (e.g. an advisory step)', () => {
  const yaml = ['      - run: npm run harness:advisory || true'].join('\n');

  assert.deepEqual(findUnsafeFallbackSteps(yaml), []);
});

test(
  "this repo's own .github/workflows/ci.yml has no guarded build/test step that " +
    'silently swallows its own failure via `|| true`',
  () => {
    const workflowYaml = readFileSync(CI_WORKFLOW_PATH, 'utf8');
    const flagged = findUnsafeFallbackSteps(workflowYaml);

    assert.deepEqual(
      flagged,
      [],
      `expected no unsafe fallback steps in ci.yml, found: ${JSON.stringify(flagged)}`,
    );
  },
);
