import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFileContention,
  contentionWarningsForBranch,
} from '../../src/control-plane/tooling/dream-cycle-contention.js';

test('computeFileContention: ignores files touched by only one branch', () => {
  const entries = computeFileContention({
    'dream/a': ['src/x.ts'],
    'dream/b': ['src/y.ts'],
  });
  assert.deepEqual(entries, []);
});

test('computeFileContention: ranks by descending branch count, ties broken by file name', () => {
  const entries = computeFileContention({
    'dream/a': ['src/hot.ts', 'src/warm.ts'],
    'dream/b': ['src/hot.ts', 'src/warm.ts'],
    'dream/c': ['src/hot.ts'],
  });
  assert.deepEqual(entries, [
    { file: 'src/hot.ts', branches: ['dream/a', 'dream/b', 'dream/c'] },
    { file: 'src/warm.ts', branches: ['dream/a', 'dream/b'] },
  ]);
});

test('computeFileContention: a branch listing the same file twice does not inflate its own count', () => {
  const entries = computeFileContention({
    'dream/a': ['src/hot.ts', 'src/hot.ts'],
    'dream/b': ['src/hot.ts'],
  });
  assert.deepEqual(entries, [{ file: 'src/hot.ts', branches: ['dream/a', 'dream/b'] }]);
});

test('computeFileContention: respects ignore patterns (e.g. the ledger every branch touches by design)', () => {
  const entries = computeFileContention(
    {
      'dream/a': ['docs/dream-cycle/LEDGER.md', 'src/hot.ts'],
      'dream/b': ['docs/dream-cycle/LEDGER.md', 'src/hot.ts'],
    },
    { ignore: [/^docs\/dream-cycle\//] },
  );
  assert.deepEqual(entries, [{ file: 'src/hot.ts', branches: ['dream/a', 'dream/b'] }]);
});

test('contentionWarningsForBranch: filters to entries involving the branch at or above the threshold', () => {
  const entries = computeFileContention({
    'dream/a': ['src/hot.ts', 'src/cold.ts'],
    'dream/b': ['src/hot.ts'],
    'dream/c': ['src/hot.ts'],
    'dream/d': ['src/cold.ts'],
  });

  assert.deepEqual(contentionWarningsForBranch(entries, 'dream/a', 3), [
    { file: 'src/hot.ts', branches: ['dream/a', 'dream/b', 'dream/c'] },
  ]);
  assert.deepEqual(contentionWarningsForBranch(entries, 'dream/a', 4), []);
  assert.deepEqual(contentionWarningsForBranch(entries, 'dream/z', 1), []);
});
