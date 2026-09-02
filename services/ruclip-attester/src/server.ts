/**
 * `ruclip-attester`'s HTTP entry point (HUMAN-CREDENTIAL-ISSUANCE-PRODUCER.md
 * §2/§4) — a real, standalone Cloud Run service. Deliberately plain
 * `node:http` (no framework) for one route, matching this repo's own
 * minimal-dependencies discipline (`store/bridge-client.ts`'s plain
 * `fetch` usage, `autogenous-client.ts`'s same choice).
 *
 * Deployed `--no-allow-unauthenticated` — Cloud Run's own IAM invoker check
 * (§3.1) is the FIRST authorization layer, enforced entirely by the
 * platform before a request ever reaches this process; this file only
 * implements the second layer (§4).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleAttestRequest, type AttestResult } from './attest-handler.js';
import { RealGoogleIdTokenVerifier } from './google-token.js';
import { lookupIdentity } from './identity-map.js';
import { mintHumanIdentityAttestation } from './signing-key.js';

const verifier = new RealGoogleIdTokenVerifier();

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/status')) {
    writeJson(res, 200, { status: 'ok', service: 'ruclip-attester' });
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/attest') {
    writeJson(res, 404, { error: 'not found' });
    return;
  }

  let result: AttestResult;
  try {
    result = await handleAttestRequest(req.headers['authorization'], {
      verifier,
      lookupIdentity: (email) => lookupIdentity(email),
      mintAttestation: (orgMemberId, companyId, humanIdentityRef) =>
        mintHumanIdentityAttestation(orgMemberId, companyId, humanIdentityRef),
    });
  } catch (err) {
    // Fail closed on anything unexpected (a secret-read failure, a
    // malformed identity-map entry, etc.) — never a partial/best-effort
    // attestation, and never leak internals in the response body.
    console.error('ruclip-attester: /v1/attest failed unexpectedly', err);
    writeJson(res, 401, { error: 'invalid identity token' });
    return;
  }
  writeJson(res, result.status, result.body);
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error('ruclip-attester: unhandled error', err);
    if (!res.headersSent) writeJson(res, 401, { error: 'invalid identity token' });
  });
});

const port = Number(process.env.PORT ?? 8080);
server.listen(port, () => {
  console.log(`ruclip-attester listening on :${port}`);
});
