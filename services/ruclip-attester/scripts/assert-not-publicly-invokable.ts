#!/usr/bin/env node
/**
 * Deploy-time guardrail: fails loudly if `ruclip-attester`'s Cloud Run IAM
 * policy would let it be invoked without authentication. Recommended by
 * ruclip-security after the live-testing round (docs/PLAN.md commit
 * 66c30dd) — orthogonal to the IAP/trust-boundary decision (that's
 * architect/team-lead's call, not built here); this only guards against a
 * real regression class: someone re-deploys with `--allow-unauthenticated`
 * later, accidentally or otherwise.
 *
 * The authoritative, checkable STATE is the service's own Cloud Run IAM
 * policy, not the `--allow-unauthenticated` flag itself (that flag is not
 * a queryable state — under the hood it just adds/removes an
 * `allUsers`/`allAuthenticatedUsers` member on the `roles/run.invoker`
 * binding). Confirmed directly against the real deployed service:
 * `gcloud run services get-iam-policy ruclip-attester --project=ruv-dev
 * --region=us-central1 --format=json` returns exactly
 * `{"bindings":[{"role":"roles/run.invoker","members":[...]}], ...}` — no
 * `allUsers`/`allAuthenticatedUsers` member today. This script re-checks
 * that fact stays true.
 *
 * Pure policy-checking logic (`assertNoPublicInvoker`) is separated from
 * the `gcloud` shell-out below, mirroring this project's own
 * dependency-injection/testability discipline — see
 * `tests/assert-not-publicly-invokable.test.ts` for fixture-based coverage
 * with no live GCP call. This CLI wrapper, run against a real service,
 * needs a real `gcloud` session — the same "CLI/dev-environment context,
 * not server-context" reasoning `identity-map.ts`'s own header now
 * documents (this is a deploy-time/CI script, run somewhere `gcloud` is
 * actually installed and authenticated, unlike the attester's own
 * container).
 *
 * **Real finding, confirmed directly (not assumed)**: `gcloud run services
 * get-iam-policy` does NOT error for a nonexistent service — it returns a
 * valid, empty policy (just `{"etag":"..."}`, no `bindings`), which
 * `assertNoPublicInvoker` correctly treats as "nothing public to flag." A
 * guardrail that silently reports "OK" for a typo'd or deleted service
 * name defeats its own purpose, so `main()` runs `gcloud run services
 * describe` first as an explicit existence check — confirmed that DOES
 * fail loudly for a real nonexistent service (`ERROR: (gcloud.run.services.
 * describe) Cannot find service [...]`, real exit 1, verified with output
 * redirected to a file rather than piped through another command, since
 * piping masks the real exit code behind the pipeline's last stage).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PUBLIC_MEMBERS = new Set(['allUsers', 'allAuthenticatedUsers']);

export interface IamBinding {
  role?: string;
  members?: string[];
}

export interface IamPolicy {
  bindings?: IamBinding[];
}

/**
 * Pure check: throws with a clear message if any `roles/run.invoker`
 * binding in `policy` grants access to `allUsers`/`allAuthenticatedUsers`.
 * Does nothing (returns normally) for every other shape, including a
 * policy with no bindings at all (Cloud Run's own default-deny — nothing
 * public to flag).
 */
export function assertNoPublicInvoker(policy: IamPolicy): void {
  const bindings = policy.bindings ?? [];
  for (const binding of bindings) {
    if (binding.role !== 'roles/run.invoker') continue;
    const members = binding.members ?? [];
    const publicMembers = members.filter((m) => PUBLIC_MEMBERS.has(m));
    if (publicMembers.length > 0) {
      throw new Error(
        `ruclip-attester's roles/run.invoker binding grants access to ${publicMembers.join(', ')} — this service ` +
          'must stay --no-allow-unauthenticated. Someone deployed with --allow-unauthenticated (or granted these ' +
          'members directly); revoke with: gcloud run services remove-iam-policy-binding <service> ' +
          `--region=<region> --member=${publicMembers[0]} --role=roles/run.invoker`,
      );
    }
  }
}

async function main(): Promise<void> {
  const serviceName = process.env.RUCLIP_ATTESTER_SERVICE_NAME ?? 'ruclip-attester';
  const region = process.env.RUCLIP_ATTESTER_GCP_REGION ?? 'us-central1';
  const project = process.env.RUCLIP_ATTESTER_GCP_PROJECT;
  if (!project) {
    console.error('RUCLIP_ATTESTER_GCP_PROJECT is not set — cannot check the live service without a project.');
    process.exitCode = 1;
    return;
  }

  // Real finding, confirmed directly: `gcloud run services get-iam-policy`
  // does NOT error for a nonexistent service — it returns a valid, empty
  // policy (`{"etag":"..."}`, no bindings), which `assertNoPublicInvoker`
  // would then treat as "safe" (nothing public to flag). A guardrail that
  // silently passes for a typo'd or deleted service defeats its own
  // purpose, so `describe` (which DOES fail loudly — confirmed:
  // `ERROR: (gcloud.run.services.describe) Cannot find service [...]`,
  // real exit 1) runs first as an explicit existence check.
  try {
    await execFileAsync('gcloud', ['run', 'services', 'describe', serviceName, `--project=${project}`, `--region=${region}`]);
  } catch (err) {
    console.error(
      `Could not confirm service '${serviceName}' exists (project '${project}', region '${region}') — is gcloud ` +
        `authenticated and the service actually deployed there? ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('gcloud', [
      'run',
      'services',
      'get-iam-policy',
      serviceName,
      `--project=${project}`,
      `--region=${region}`,
      '--format=json',
    ]));
  } catch (err) {
    console.error(
      `Failed to read ${serviceName}'s IAM policy (project '${project}', region '${region}') — is gcloud ` +
        `authenticated? ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  let policy: IamPolicy;
  try {
    policy = JSON.parse(stdout) as IamPolicy;
  } catch (err) {
    console.error('gcloud returned non-JSON output for get-iam-policy', err);
    process.exitCode = 1;
    return;
  }

  try {
    assertNoPublicInvoker(policy);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  console.log(`OK: ${serviceName} (project '${project}', region '${region}') is not publicly invokable.`);
}

// Only run when invoked directly (not when imported for tests).
if (process.argv[1] && process.argv[1].endsWith('assert-not-publicly-invokable.js')) {
  void main();
}
