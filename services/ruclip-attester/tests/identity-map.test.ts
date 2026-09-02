/**
 * Coverage for identity-map.ts — HUMAN-CREDENTIAL-ISSUANCE-PRODUCER.md §3.2's
 * read-only lookup. No live GCP Secret Manager call — the `mapJson`
 * test/dev override bypasses the shell-out entirely, same discipline as
 * credential-issuer.ts's own `privateKeyPem` override.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupIdentity } from '../src/identity-map.js';

const FIXTURE_MAP = JSON.stringify({
  'ruv@ruv.net': { orgMemberId: 'om-ceo-001', companyId: 'company-ruclip-001' },
});

test('lookupIdentity returns the mapped entry for a known email', async () => {
  const result = await lookupIdentity('ruv@ruv.net', { mapJson: FIXTURE_MAP });
  assert.deepEqual(result, { orgMemberId: 'om-ceo-001', companyId: 'company-ruclip-001' });
});

test('lookupIdentity returns null for an unmapped email — not an error', async () => {
  const result = await lookupIdentity('nobody@ruv.net', { mapJson: FIXTURE_MAP });
  assert.equal(result, null);
});

test('lookupIdentity throws on malformed JSON in the secret', async () => {
  await assert.rejects(() => lookupIdentity('ruv@ruv.net', { mapJson: 'not json' }));
});

test('lookupIdentity throws when the secret is a JSON array, not an object', async () => {
  await assert.rejects(() => lookupIdentity('ruv@ruv.net', { mapJson: '[]' }));
});

test('lookupIdentity throws when an entry is missing orgMemberId/companyId', async () => {
  await assert.rejects(() => lookupIdentity('ruv@ruv.net', { mapJson: JSON.stringify({ 'ruv@ruv.net': { orgMemberId: 'om-1' } }) }));
});

test('lookupIdentity throws when neither mapJson nor secretName/secretProject are configured', async () => {
  const previousSecret = process.env.RUCLIP_ATTESTER_IDENTITY_MAP_SECRET;
  const previousProject = process.env.RUCLIP_ATTESTER_IDENTITY_MAP_PROJECT;
  delete process.env.RUCLIP_ATTESTER_IDENTITY_MAP_SECRET;
  delete process.env.RUCLIP_ATTESTER_IDENTITY_MAP_PROJECT;
  try {
    await assert.rejects(() => lookupIdentity('ruv@ruv.net', {}));
  } finally {
    if (previousSecret !== undefined) process.env.RUCLIP_ATTESTER_IDENTITY_MAP_SECRET = previousSecret;
    if (previousProject !== undefined) process.env.RUCLIP_ATTESTER_IDENTITY_MAP_PROJECT = previousProject;
  }
});
