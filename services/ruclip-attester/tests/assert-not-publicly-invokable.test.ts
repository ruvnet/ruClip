/**
 * Coverage for the deploy-time IAM guardrail (ruclip-security's
 * recommendation, docs/PLAN.md commit 66c30dd's follow-on): fixture-based,
 * no live GCP call — mirrors the real IAM policy shape confirmed against
 * the actual deployed `ruclip-attester` service
 * (`gcloud run services get-iam-policy ... --format=json`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNoPublicInvoker } from '../scripts/assert-not-publicly-invokable.js';

test('assertNoPublicInvoker does not throw for the real, current, non-public policy shape', () => {
  assert.doesNotThrow(() =>
    assertNoPublicInvoker({
      bindings: [{ role: 'roles/run.invoker', members: ['serviceAccount:ruclip-attester@ruv-dev.iam.gserviceaccount.com'] }],
    }),
  );
});

test('assertNoPublicInvoker does not throw when there are no bindings at all (default-deny)', () => {
  assert.doesNotThrow(() => assertNoPublicInvoker({ bindings: [] }));
  assert.doesNotThrow(() => assertNoPublicInvoker({}));
});

test('assertNoPublicInvoker does not throw for a non-invoker role granted to allUsers (irrelevant role)', () => {
  assert.doesNotThrow(() => assertNoPublicInvoker({ bindings: [{ role: 'roles/run.viewer', members: ['allUsers'] }] }));
});

test('assertNoPublicInvoker throws when roles/run.invoker is granted to allUsers — the real --allow-unauthenticated shape', () => {
  assert.throws(
    () => assertNoPublicInvoker({ bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] }),
    /allUsers/,
  );
});

test('assertNoPublicInvoker throws when roles/run.invoker is granted to allAuthenticatedUsers', () => {
  assert.throws(
    () => assertNoPublicInvoker({ bindings: [{ role: 'roles/run.invoker', members: ['allAuthenticatedUsers'] }] }),
    /allAuthenticatedUsers/,
  );
});

test('assertNoPublicInvoker throws when allUsers is mixed in alongside legitimate service-account members', () => {
  assert.throws(() =>
    assertNoPublicInvoker({
      bindings: [
        {
          role: 'roles/run.invoker',
          members: ['serviceAccount:ruclip-attester@ruv-dev.iam.gserviceaccount.com', 'allUsers'],
        },
      ],
    }),
  );
});

test('assertNoPublicInvoker checks every binding, not just the first', () => {
  assert.throws(() =>
    assertNoPublicInvoker({
      bindings: [
        { role: 'roles/run.viewer', members: ['user:someone@ruv.net'] },
        { role: 'roles/run.invoker', members: ['serviceAccount:legit@ruv-dev.iam.gserviceaccount.com'] },
        { role: 'roles/run.invoker', members: ['allUsers'] },
      ],
    }),
  );
});
