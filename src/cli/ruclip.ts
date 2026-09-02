#!/usr/bin/env node
/**
 * `ruclip` — the first CLI entry point in this repo
 * (HUMAN-CREDENTIAL-ISSUANCE-PRODUCER.md §0.6/§5). v1 has exactly one
 * subcommand, `login`.
 *
 * `ruclip login` steps (§5), fail-closed throughout — any failure at any
 * step aborts with a non-zero exit and NO credential is held or printed;
 * there is no partial/best-effort success path:
 * 1. `gcloud auth print-identity-token` (bare — no `--audiences`, which
 *    errors for a plain user account, §0.3's confirmed finding).
 * 2. `POST $RUCLIP_ATTESTER_URL/v1/attest` with that token as the bearer.
 * 3. On a 200, calls the existing, unmodified `mintHumanActorCredential`
 *    with the returned attestation.
 * 4. Holds the resulting `ActorCredential` for the remainder of this CLI
 *    invocation (15 min TTL, unchanged) — printed to stdout so the
 *    invoking shell/script can capture it; this command does not itself
 *    persist a session file (no other subcommand exists yet to consume
 *    one — see file header discussion in the design doc, §5).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mintHumanActorCredential,
  resolveAdmittedAttesterKeys,
  type HumanIdentityAttestation,
} from '../control-plane/authorization/human-identity-attestation.js';
import type { IssuerKeyConfig } from '../control-plane/authorization/credential-issuer.js';
import type { AgentDbAdapterConfig } from '../control-plane/store/bridge-client.js';

const execFileAsync = promisify(execFile);

export class RuclipLoginError extends Error {}

async function getGoogleIdToken(): Promise<string> {
  try {
    // Bare — no --audiences. See file header point 1.
    const { stdout } = await execFileAsync('gcloud', ['auth', 'print-identity-token']);
    const token = stdout.trim();
    if (!token) throw new Error('gcloud printed an empty identity token');
    return token;
  } catch (err) {
    throw new RuclipLoginError(
      'Could not get a Google identity token via gcloud — is gcloud installed and authenticated ' +
        "('gcloud auth login')?",
      { cause: err },
    );
  }
}

export interface LoginDeps {
  getGoogleIdToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  attesterUrl?: string;
  /** Injectable AgentDB bridge config, threaded through to mintHumanActorCredential — testability only; a real invocation uses the default bridge resolution. */
  bridgeConfig?: AgentDbAdapterConfig;
  /** Injectable ruClip issuer-key config, threaded through to mintHumanActorCredential — testability only; a real invocation reads RUCLIP_ISSUER_SIGNING_SECRET/_PROJECT, same as every other credential-issuer.ts caller. */
  issuerConfig?: IssuerKeyConfig;
}

export async function login(deps: LoginDeps = { getGoogleIdToken }): Promise<{
  credential: Awaited<ReturnType<typeof mintHumanActorCredential>>;
  attestation: HumanIdentityAttestation;
}> {
  const attesterUrl = deps.attesterUrl ?? process.env.RUCLIP_ATTESTER_URL;
  if (!attesterUrl) {
    throw new RuclipLoginError('RUCLIP_ATTESTER_URL is not set — cannot reach the attester service');
  }

  const idToken = await deps.getGoogleIdToken();

  const fetchFn = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(`${attesterUrl}/v1/attest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${idToken}` },
    });
  } catch (err) {
    throw new RuclipLoginError(`Could not reach ruclip-attester at ${attesterUrl}: ${(err as Error).message}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new RuclipLoginError(`ruclip-attester refused this login (HTTP ${response.status}): ${body || 'no details'}`);
  }
  const attestation = (await response.json()) as HumanIdentityAttestation;

  const admittedAttesterKeys = resolveAdmittedAttesterKeys();
  const credential = await mintHumanActorCredential(
    attestation,
    admittedAttesterKeys,
    undefined,
    deps.issuerConfig,
    deps.bridgeConfig,
  );
  return { credential, attestation };
}

async function main(): Promise<void> {
  const subcommand = process.argv[2];
  if (subcommand !== 'login') {
    console.error('Usage: ruclip login');
    process.exitCode = 1;
    return;
  }
  try {
    const { credential, attestation } = await login();
    console.log(
      `Logged in as ${attestation.humanIdentityRef} (OrgMember ${credential.orgMemberId}, company ` +
        `${credential.companyId}). Credential expires at ${credential.expiresAt}.`,
    );
    console.log(JSON.stringify(credential));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

// Only run when invoked directly (not when imported for tests).
if (process.argv[1] && process.argv[1].endsWith('ruclip.js')) {
  void main();
}
