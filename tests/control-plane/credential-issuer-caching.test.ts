/**
 * Dream Cycle 2026-10-28 (performance): `credential-issuer.ts`'s
 * `loadIssuerKeypair` resolved the issuer's private key (a `gcloud secrets
 * versions access` subprocess spawn when no `privateKeyPem` override is
 * given) on every single `mintActorCredential`/`resolveAdmittedIssuerKeys`
 * call — no cache. `services/ruclip-attester/src/signing-key.ts` (dream-cycle
 * PR #59, 2026-10-06) already closed this exact class of gap for a sibling
 * secret with a 60s in-memory TTL cache, mirroring `identity-map.ts`/
 * `google-token.ts`. This reproduces that same proof against a real fake
 * secret accessor (counts real calls through the real `resolvePrivateKeyPem`/
 * `loadIssuerKeypair` code path, not an internal mock of the function under
 * test) rather than inferring the call count from source reading.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintActorCredential, resolveAdmittedIssuerKeys } from '../../src/control-plane/authorization/credential-issuer.js';

const TEST_PRIVATE_KEY_PEM =
  '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIM8F4M0wgWHu3FFIPB4D7vrH/DZgu0MXNn/bDb4KQKzw\n-----END PRIVATE KEY-----\n';

// Both invariants share one test, deliberately: the module-level cache this
// candidate adds is process-lifetime state, so splitting "cache is reused"
// and "override bypasses the cache" across separate test() calls would let
// whichever runs second inherit the first's already-warm cache and silently
// stop exercising the cold-cache path it claims to test.
test('mintActorCredential reuses the issuer secret read across calls within the cache TTL, and privateKeyPem always bypasses it', async () => {
  let accessCount = 0;
  const issuerConfig = {
    secretName: 'dream-cycle-test-issuer-secret',
    secretProject: 'dream-cycle-test-project',
    secretAccessor: async () => {
      accessCount += 1;
      return TEST_PRIVATE_KEY_PEM;
    },
  };

  const first = await mintActorCredential('om-1', 'co-1', undefined, issuerConfig);
  const second = await mintActorCredential('om-2', 'co-2', undefined, issuerConfig);
  const admitted = await resolveAdmittedIssuerKeys(issuerConfig);

  assert.equal(first.issuerPublicKeyDerHex, second.issuerPublicKeyDerHex);
  assert.ok(admitted.has(first.issuerPublicKeyDerHex));
  assert.equal(
    accessCount,
    1,
    `expected the cached issuer keypair to be reused (1 secret read for 3 calls), got ${accessCount}`,
  );

  // A direct privateKeyPem override must never read from — or be shadowed
  // by — the now-warm cache above.
  const otherKeyPem =
    '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIBIi+Qvfjx2WKGckXxM4S4tO/qRk1D7AAyf/9LIyYsvC\n-----END PRIVATE KEY-----\n';
  const overridden = await mintActorCredential('om-4', 'co-4', undefined, { privateKeyPem: otherKeyPem });

  assert.notEqual(overridden.issuerPublicKeyDerHex, first.issuerPublicKeyDerHex);
  assert.equal(accessCount, 1, 'the privateKeyPem override must not touch secretAccessor at all');
});
