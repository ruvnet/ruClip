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
 * **Real-behavior correction from LIVE deployment testing (2026-09-02,
 * this session), not from reading source**: this module originally read
 * the secret by shelling out to the `gcloud` CLI, mirroring
 * `credential-issuer.ts`'s own discipline. Deployed to the real
 * `ruclip-attester` Cloud Run service and got `spawn gcloud ENOENT` —
 * confirmed via the service's own Cloud Run logs, not assumed. The
 * `node:20-slim` container this service runs in has NO `gcloud` CLI
 * installed at all — `credential-issuer.ts`'s shell-out pattern is correct
 * for ITS callers (this repo's own dev/CI/publish environment, which does
 * have `gcloud` on `PATH`, per root `CLAUDE.md`'s documented npm-publish
 * flow) but cannot work inside a server-side Cloud Run container with no
 * CLI and no interactive `gcloud` session. The correct mechanism for a
 * Cloud Run service reading its OWN secrets is the official
 * `@google-cloud/secret-manager` client library, which authenticates via
 * Application Default Credentials — the service's own runtime service
 * account, automatically, no `gcloud` binary needed. Still: never logged,
 * never written to disk, no hardcoded secret name/project.
 */
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

let secretManagerClient: SecretManagerServiceClient | null = null;
function getSecretManagerClient(): SecretManagerServiceClient {
  secretManagerClient ??= new SecretManagerServiceClient();
  return secretManagerClient;
}

export interface IdentityMapConfig {
  /** Test/dev-only escape hatch — the raw mapping JSON, bypassing the GCP Secret Manager client entirely. */
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
    const [response] = await getSecretManagerClient().accessSecretVersion({
      name: `projects/${secretProject}/secrets/${secretName}/versions/latest`,
    });
    const data = response.payload?.data;
    if (data === undefined || data === null) {
      throw new Error('Secret Manager returned no payload data');
    }
    return Buffer.from(data).toString('utf8').trim();
  } catch (err) {
    throw new Error(
      `Failed to read the identity-mapping secret from GCP Secret Manager (secret '${secretName}', project ` +
        `'${secretProject}') — is the service's own runtime service account granted access, and is the secret ` +
        'provisioned?',
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
