/**
 * Read-only lookup of `ruclip-attester-identity-map`
 * (HUMAN-CREDENTIAL-ISSUANCE-PRODUCER.md §3.2) — Google email →
 * `{orgMemberId, companyId}`. There is deliberately no write path anywhere
 * in this module, or anywhere else in `ruclip-attester` — that absence IS
 * the security boundary team-lead's requirement named (§1/§3.3): the only
 * way to add/change/remove a mapping entry is `gcloud secrets versions add`
 * against this one named secret, by whoever already holds deploy/secret-edit
 * authority over this GCP project.
 *
 * Same GCP Secret Manager discipline as `credential-issuer.ts`'s key read
 * (`execFile` with an argument array — never a shell string — never
 * logged, never written to disk, no hardcoded secret name/project). Resolved
 * fresh on a short in-memory TTL rather than cached indefinitely (§3.2) —
 * a revoked mapping entry should stop being honored within one TTL window,
 * not require a process restart.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface IdentityMapConfig {
  /** Test/dev-only escape hatch — the raw mapping JSON, bypassing the GCP Secret Manager shell-out entirely. */
  mapJson?: string;
  /** Overrides RUCLIP_ATTESTER_IDENTITY_MAP_SECRET. */
  secretName?: string;
  /** Overrides RUCLIP_ATTESTER_IDENTITY_MAP_PROJECT. */
  secretProject?: string;
}

export interface IdentityMappingEntry {
  orgMemberId: string;
  companyId: string;
}

async function resolveIdentityMapJson(config?: IdentityMapConfig): Promise<string> {
  if (config?.mapJson !== undefined) return config.mapJson;

  const secretName = config?.secretName ?? process.env.RUCLIP_ATTESTER_IDENTITY_MAP_SECRET;
  const secretProject = config?.secretProject ?? process.env.RUCLIP_ATTESTER_IDENTITY_MAP_PROJECT;
  if (!secretName || !secretProject) {
    throw new Error(
      'No identity-mapping secret available: pass config.mapJson for tests/dev, or set both ' +
        'RUCLIP_ATTESTER_IDENTITY_MAP_SECRET and RUCLIP_ATTESTER_IDENTITY_MAP_PROJECT to a provisioned GCP ' +
        'Secret Manager secret — provisioning that secret is a deployment step outside this code',
    );
  }
  try {
    const { stdout } = await execFileAsync('gcloud', [
      'secrets',
      'versions',
      'access',
      'latest',
      `--secret=${secretName}`,
      `--project=${secretProject}`,
    ]);
    return stdout.trim();
  } catch (err) {
    throw new Error(
      `Failed to read the identity-mapping secret from GCP Secret Manager (secret '${secretName}', project ` +
        `'${secretProject}') — is gcloud authenticated and the secret provisioned?`,
      { cause: err },
    );
  }
}

function parseIdentityMap(json: string): Record<string, IdentityMappingEntry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error('Identity-mapping secret is not valid JSON', { cause: err });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Identity-mapping secret must be a JSON object of email -> {orgMemberId, companyId}');
  }
  for (const [email, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof (entry as Record<string, unknown>).orgMemberId !== 'string' ||
      typeof (entry as Record<string, unknown>).companyId !== 'string'
    ) {
      throw new Error(`Identity-mapping secret entry for '${email}' is malformed (expected {orgMemberId, companyId})`);
    }
  }
  return parsed as Record<string, IdentityMappingEntry>;
}

const CACHE_TTL_MS = 60_000;
let cache: { value: Record<string, IdentityMappingEntry>; fetchedAt: number } | null = null;

async function loadIdentityMap(config?: IdentityMapConfig): Promise<Record<string, IdentityMappingEntry>> {
  // The test/dev mapJson override always re-parses fresh (no caching) so
  // tests observe the exact fixture they passed, never a stale one from a
  // previous test's cache.
  if (config?.mapJson !== undefined) {
    return parseIdentityMap(config.mapJson);
  }
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.value;
  }
  const json = await resolveIdentityMapJson(config);
  const value = parseIdentityMap(json);
  cache = { value, fetchedAt: Date.now() };
  return value;
}

export async function lookupIdentity(email: string, config?: IdentityMapConfig): Promise<IdentityMappingEntry | null> {
  const map = await loadIdentityMap(config);
  return map[email] ?? null;
}
