/**
 * Flags CI workflow `run:` steps that shell out to a build/test-correctness
 * command but suffix it with `|| true` (or a bare-`true` fallback chained
 * with `;`), which forces the step's exit code to 0 regardless of whether
 * the command actually succeeded.
 *
 * Finding (2026-10-09, developer-experience): `.github/workflows/ci.yml`'s
 * `scaffold-check` job runs `npm install --no-audit --no-fund || true`
 * before `npm run build`/`npm test`. If install genuinely fails (registry
 * outage, lockfile/engine drift, a transient network error), the `|| true`
 * swallows that failure and the job proceeds anyway, against a missing or
 * partial `node_modules`. The resulting red build is then misattributed to
 * `npm run build` or `npm test` — whichever step happens to trip over the
 * broken install first — not to the real root cause, which never appears
 * in the log as a failure at all. This module is a pure, read-only
 * classifier over workflow YAML text; it does not know how to fix a step,
 * only how to flag one.
 */

export interface UnsafeWorkflowStep {
  /** 1-indexed line number within the scanned text. */
  line: number;
  /** The full `run:` command text that was flagged. */
  command: string;
}

/**
 * Commands whose failure must stop the job: a build or test step silently
 * continuing past one of these is never correct for this repo's own
 * evaluator contract (`npm test` = `tsc` then `node --test`, both of which
 * assume a complete, successful prior install).
 */
const GUARDED_COMMAND_PATTERN = /\b(npm (ci|install|run build|test)|tsc)\b/;

/** Matches a trailing `|| true` (optionally preceded by `;`), the shell idiom for "always exit 0". */
const UNSAFE_FALLBACK_PATTERN = /(\|\||;)\s*true\s*$/;

/**
 * Scans `workflowYaml` line by line for `run:` steps (inline, single-line
 * form only — this repo's own `ci.yml` never uses the multi-line `run: |`
 * block form) that match both: a guarded command, and an unsafe fallback
 * suffix. Returns one entry per flagged line, in file order.
 */
export function findUnsafeFallbackSteps(workflowYaml: string): UnsafeWorkflowStep[] {
  const flagged: UnsafeWorkflowStep[] = [];
  const lines = workflowYaml.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const runMatch = /^\s*-?\s*run:\s*(.+)$/.exec(line);
    if (!runMatch) continue;
    const command = (runMatch[1] ?? '').trim();
    if (GUARDED_COMMAND_PATTERN.test(command) && UNSAFE_FALLBACK_PATTERN.test(command)) {
      flagged.push({ line: i + 1, command });
    }
  }

  return flagged;
}
