/**
 * Standalone worker process for
 * `tests/control-plane/actor-credential-nonce-durable-backend.test.ts`'s
 * real, two-OS-process race: spawned twice against the same on-disk SQLite
 * file, both instances race the same `memory_store({upsert:false})` call for
 * the same (namespace, key). Not a `*.test.ts` file — the test runner globs
 * only `*.test.js`, so this compiles alongside the suite without being
 * picked up as a test of its own.
 *
 * `CLAUDE_FLOW_DISABLE_BRIDGE=1` forces the sql.js (WASM SQLite) fallback
 * path rather than the native `better-sqlite3` bridge — the bridge path
 * eagerly initializes a transformer embedding model on first use (real,
 * observed behavior, not assumed), which is slow and network-dependent and
 * would make this race non-deterministic under CI. Both paths write through
 * the identical `UNIQUE(namespace, key)` SQL contract (see
 * `docs/dream-cycle/2026-09-06-security-report.md`'s Candidate section) —
 * sql.js exercises the same real constraint without that dependency.
 */
process.env.CLAUDE_FLOW_DISABLE_BRIDGE = '1';

const [, , rawDbPath, rawKey, rawNamespace, rawBarrierPath] = process.argv;
if (!rawDbPath || !rawKey || !rawNamespace || !rawBarrierPath) {
  console.error('usage: nonce-store-race-worker.js <dbPath> <key> <namespace> <barrierPath>');
  process.exit(2);
}
const dbPath: string = rawDbPath;
const key: string = rawKey;
const namespace: string = rawNamespace;
const barrierPath: string = rawBarrierPath;

const { storeEntry } = await import('@claude-flow/cli/memory');
const { accessSync } = await import('node:fs');

// Busy-wait for the parent's barrier file so both worker processes race the
// store as close together as the OS scheduler allows, rather than one
// finishing module load/setup before the other has even started.
async function waitForBarrier(): Promise<void> {
  for (;;) {
    try {
      accessSync(barrierPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
}

await waitForBarrier();
const result = await storeEntry({
  key,
  value: 'true',
  namespace,
  ttl: 60,
  upsert: false,
  generateEmbeddingFlag: false,
  dbPath,
});
process.stdout.write(JSON.stringify({ success: result.success }) + '\n');
process.exit(0);
