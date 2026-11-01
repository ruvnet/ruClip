import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenVersions, classify, type NpmLsNode, type FlaggedInstall } from '../../src/tooling/audit-reachability.js';

test('flattenVersions collects every (name, version) pair at any depth', () => {
  const tree: NpmLsNode = {
    dependencies: {
      a: {
        version: '1.0.0',
        dependencies: {
          b: { version: '2.0.0' },
        },
      },
      c: { version: '3.0.0' },
    },
  };
  const versions = flattenVersions(tree);
  assert.deepEqual([...(versions.get('a') ?? [])], ['1.0.0']);
  assert.deepEqual([...(versions.get('b') ?? [])], ['2.0.0']);
  assert.deepEqual([...(versions.get('c') ?? [])], ['3.0.0']);
  assert.equal(versions.get('missing'), undefined);
});

test('flattenVersions keeps every distinct version when a name is installed more than once', () => {
  const tree: NpmLsNode = {
    dependencies: {
      a: {
        version: '1.0.0',
        dependencies: { shared: { version: '1.0.0' } },
      },
      b: {
        version: '2.0.0',
        dependencies: { shared: { version: '2.0.0' } },
      },
    },
  };
  const versions = flattenVersions(tree);
  assert.deepEqual([...(versions.get('shared') ?? [])].sort(), ['1.0.0', '2.0.0']);
});

test('classify: a flagged version absent from the production tree is NOT reachable (the protobufjs case)', () => {
  // Mirrors tonight's real finding: a safe copy of a package is genuinely
  // production-reachable, but npm audit flags a *different*, unpatched
  // copy's version that only exists under a peerDependency's own subtree.
  const findings: FlaggedInstall[] = [
    { name: 'protobufjs', severity: 'critical', version: '6.11.6', path: 'node_modules/onnx-proto/node_modules/protobufjs' },
  ];
  const prodVersions = new Map<string, Set<string>>([['protobufjs', new Set(['7.6.6'])]]);
  const [result] = classify(findings, prodVersions);
  assert.equal(result!.reachableFromProduction, false);
});

test('classify: a flagged version present in the production tree IS reachable (the grpc-js case)', () => {
  const findings: FlaggedInstall[] = [
    { name: '@grpc/grpc-js', severity: 'high', version: '1.14.4', path: 'node_modules/@grpc/grpc-js' },
  ];
  const prodVersions = new Map<string, Set<string>>([['@grpc/grpc-js', new Set(['1.14.4'])]]);
  const [result] = classify(findings, prodVersions);
  assert.equal(result!.reachableFromProduction, true);
});

test('classify: a package absent from the production tree entirely is NOT reachable (the proxy-addr/toml case)', () => {
  const findings: FlaggedInstall[] = [
    { name: 'proxy-addr', severity: 'critical', version: '2.0.7', path: 'node_modules/proxy-addr' },
  ];
  const prodVersions = new Map<string, Set<string>>();
  const [result] = classify(findings, prodVersions);
  assert.equal(result!.reachableFromProduction, false);
});

test('classify preserves input order and all fields', () => {
  const findings: FlaggedInstall[] = [
    { name: 'x', severity: 'moderate', version: '1.0.0', path: 'node_modules/x' },
    { name: 'y', severity: 'low', version: '2.0.0', path: 'node_modules/y' },
  ];
  const results = classify(findings, new Map());
  assert.equal(results.length, 2);
  assert.equal(results[0]!.name, 'x');
  assert.equal(results[1]!.name, 'y');
  assert.equal(results[0]!.reachableFromProduction, false);
  assert.equal(results[1]!.reachableFromProduction, false);
});
