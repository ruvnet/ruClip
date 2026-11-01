#!/usr/bin/env node
/**
 * Dream Cycle 2026-11-01 (security deep dive + dependencies,secrets scan).
 *
 * `npm audit` flags findings by package *name* only. This repo's own
 * `package.json` lists exactly two runtime `dependencies`
 * (`@google-cloud/secret-manager`, `google-auth-library`); everything else
 * `npm audit` complains about arrives transitively under the `ruflo`
 * peerDependency — the dream-machine tooling this session runs *alongside*,
 * never `import`ed by `src/`/`services/` (confirmed: no match for any
 * audit-flagged package name in a repo-wide grep of `src`/`services`).
 *
 * Four open dream-cycle PRs (#29 protobufjs, #39 toml, #51 grpc-js, #100
 * proxy-addr) already each did this reachability check manually, once, for
 * one finding. Real risk found tonight in redoing it at the audit's current
 * 53-finding scale: **matching by package name alone is unsound** — a
 * package can have an unpatched copy nested under `ruflo` *and* a separate,
 * already-patched copy genuinely loaded by this repo's own two production
 * dependencies (protobufjs is exactly this case: the production-reachable
 * copy is `7.6.6`, safe; the copy `npm audit` actually flags is `6.11.6`,
 * nested under `ruflo`'s `agentic-flow`→`onnx-proto`). This tool classifies
 * by the *exact installed version at the exact flagged path*, not by name,
 * to avoid that false positive (and its mirror false negative).
 *
 * Algorithm: for each `npm audit --json` finding at or above `minSeverity`,
 * read the real installed version at each of its reported `nodes` paths,
 * then check whether that (name, version) pair appears anywhere in the
 * dependency tree computed with `npm ls --all --json --omit=dev --omit=peer
 * --omit=optional` — the subtree `npm` itself resolves as reachable from
 * this package's `dependencies` alone. `flattenVersions`/`classify` are
 * pure and unit-tested against fixture trees (no network, no real `npm`
 * call); `main()` is the real `npm audit`/`npm ls` wiring, exercised by
 * tonight's actual receipt in the dream-cycle report, not by the test
 * suite.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export type Severity = 'low' | 'moderate' | 'high' | 'critical';

const SEVERITY_RANK: Record<Severity, number> = { low: 0, moderate: 1, high: 2, critical: 3 };

export interface NpmLsNode {
  version?: string;
  dependencies?: Record<string, NpmLsNode>;
}

/** Every (package name, version) pair appearing anywhere in an `npm ls --json` tree. */
export function flattenVersions(tree: NpmLsNode): Map<string, Set<string>> {
  const versions = new Map<string, Set<string>>();
  const walk = (node: NpmLsNode): void => {
    if (!node.dependencies) return;
    for (const [name, child] of Object.entries(node.dependencies)) {
      if (child.version) {
        let set = versions.get(name);
        if (!set) {
          set = new Set();
          versions.set(name, set);
        }
        set.add(child.version);
      }
      walk(child);
    }
  };
  walk(tree);
  return versions;
}

export interface FlaggedInstall {
  name: string;
  severity: Severity;
  /** The exact version installed at `path` — the copy npm audit is actually flagging. */
  version: string;
  path: string;
}

export interface ReachabilityResult extends FlaggedInstall {
  reachableFromProduction: boolean;
}

/** Pure classification: is each flagged (name, version) pair present in the production-only tree? */
export function classify(findings: FlaggedInstall[], prodVersions: Map<string, Set<string>>): ReachabilityResult[] {
  return findings.map((finding) => ({
    ...finding,
    reachableFromProduction: prodVersions.get(finding.name)?.has(finding.version) ?? false,
  }));
}

interface NpmAuditVulnerability {
  severity: Severity;
  nodes?: string[];
}

interface NpmAuditJson {
  vulnerabilities?: Record<string, NpmAuditVulnerability>;
}

async function runJson<T>(command: string, args: string[]): Promise<T> {
  // npm exits non-zero whenever `npm audit` finds anything, and `npm ls`
  // when `--omit` prunes a peer dep with its own peer-dependency warnings —
  // both still print the JSON we want on stdout, so a thrown exit code
  // (which execFile surfaces as an error carrying `stdout`/`stderr`) is not
  // itself a failure here; only unparsable stdout is.
  try {
    const { stdout } = await execFileAsync(command, args, { maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout) as T;
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout;
    if (stdout) return JSON.parse(stdout) as T;
    throw err;
  }
}

/** Reads the real installed version at `nodeModulesPath` (e.g. "node_modules/onnx-proto/node_modules/protobufjs"). */
function readInstalledVersion(cwd: string, nodeModulesPath: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, nodeModulesPath, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

export async function collectFlaggedInstalls(cwd: string, minSeverity: Severity): Promise<FlaggedInstall[]> {
  const audit = await runJson<NpmAuditJson>('npm', ['audit', '--json']);
  const findings: FlaggedInstall[] = [];
  for (const [name, vuln] of Object.entries(audit.vulnerabilities ?? {})) {
    if (SEVERITY_RANK[vuln.severity] < SEVERITY_RANK[minSeverity]) continue;
    for (const path of vuln.nodes ?? []) {
      const version = readInstalledVersion(cwd, path);
      if (version) findings.push({ name, severity: vuln.severity, version, path });
    }
  }
  return findings;
}

export async function collectProductionVersions(cwd: string): Promise<Map<string, Set<string>>> {
  const tree = await runJson<NpmLsNode>('npm', ['ls', '--all', '--json', '--omit=dev', '--omit=peer', '--omit=optional']);
  return flattenVersions(tree);
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const minSeverity: Severity = 'high';
  const [findings, prodVersions] = await Promise.all([
    collectFlaggedInstalls(cwd, minSeverity),
    collectProductionVersions(cwd),
  ]);
  const results = classify(findings, prodVersions);

  const reachable = results.filter((r) => r.reachableFromProduction);
  const unreachable = results.filter((r) => !r.reachableFromProduction);

  console.log(`Reachable from this package's own production dependencies (${reachable.length}):`);
  for (const r of reachable) {
    console.log(`  [${r.severity}] ${r.name}@${r.version}  (${r.path})`);
  }
  console.log(`\nOnly reachable via peerDependencies/devDependencies tooling, e.g. ruflo (${unreachable.length}):`);
  for (const r of unreachable) {
    console.log(`  [${r.severity}] ${r.name}@${r.version}  (${r.path})`);
  }

  if (reachable.length > 0) {
    console.error(`\n${reachable.length} finding(s) at or above '${minSeverity}' are reachable from production dependencies.`);
    process.exitCode = 1;
  } else {
    console.log('\nOK: no high/critical npm audit finding is reachable from this package\'s own production dependencies.');
  }
}

// Only run when invoked directly (not when imported for tests).
if (process.argv[1] && process.argv[1].endsWith('audit-reachability.js')) {
  void main();
}
