/**
 * Independent coverage for the AgentRadio/radio-moe signing follow-up
 * (commit 65dbbab on top of 95d17f8/467c4d9): AgentBbsNotificationChannel's
 * optional ed25519 signing layer over `radio-moe`'s real, installed
 * PeerIdentity/signFrame/verifyFrame API.
 *
 * Complements tests/control-plane/heartbeats-and-comms.test.ts's own two new
 * tests (a happy-path sign->verify round trip, and a tamper-evidence check
 * that varies `payload`). This file specifically probes what fields the
 * signed frame actually covers — since `verifySignedNotification`'s whole
 * purpose is "prove this NotificationEvent wasn't tampered with," every
 * field a caller might reasonably expect to be covered should actually be
 * covered, or the tamper-evidence claim is partial in a way nobody has
 * tested yet.
 *
 * FINDING (test 1 below): `notificationFrame()` in
 * comms/agentbbs-notification-channel.ts builds the signed payload from
 * `requestId: event.subjectRef`, `value: {kind, companyId, payload}` — it
 * does NOT include `event.occurredAt` anywhere. That means
 * `verifySignedNotification` returns `true` for an event whose `occurredAt`
 * has been changed after signing, as long as `subjectRef`/`kind`/
 * `companyId`/`payload` are unchanged. Since `occurredAt` is part of what
 * gets published (`publish()` includes it in the outbound payload
 * alongside the signature) and is a semantically meaningful audit-trail
 * field (per HEARTBEATS-AND-COMMS.md's own framing — this signing layer
 * exists specifically for "tamper-evidence/provenance"), a receiver calling
 * `verifySignedNotification(event, signature) === true` would reasonably
 * assume the ENTIRE event they were handed — including when it claims to
 * have happened — is verified. It isn't: `occurredAt` can be altered
 * without invalidating the signature. Test 1 proves this concretely against
 * the real, installed radio-moe package (not a mock of it).
 *
 * Tests 2-4 are coverage the coder's own single tamper-evidence test
 * (payload-only) doesn't reach: cross-company replay, subjectRef tampering,
 * and a corrupted/garbage signature string never throwing.
 *
 * radio-moe is a real devDependency here (package.json) — these tests
 * exercise the actual published API, same discipline as the coder's own
 * signing tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockBridge } from '../support/mock-bridge.js';
import {
  AgentBbsNotificationChannel,
  verifySignedNotification,
  type RadioMoeSignature,
} from '../../src/control-plane/comms/agentbbs-notification-channel.js';
import type { NotificationEvent } from '../../src/control-plane/schema/notification.js';

const now = '2026-09-01T00:00:00.000Z';
const later = '2026-09-01T23:59:59.000Z';

function baseEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    kind: 'issue-approval-transition',
    companyId: 'co-1',
    subjectRef: 'issue:issue-1',
    payload: { issueId: 'issue-1', action: 'approve' },
    occurredAt: now,
    ...overrides,
  };
}

async function publishAndCapture(event: NotificationEvent): Promise<RadioMoeSignature> {
  const captured: { payload?: Record<string, unknown> } = {};
  const { config } = mockBridge({
    'federation_bbs_publish': (args) => {
      captured.payload = args.payload as Record<string, unknown>;
      return { success: true, envelopeId: 'env-1' };
    },
  });
  const channel = new AgentBbsNotificationChannel('room-1', config);
  await channel.publish(event);
  return (captured.payload!.radioMoeSignature as RadioMoeSignature);
}

// --- Finding: occurredAt is not covered by the signature ---

test(
  'FINDING: verifySignedNotification still returns true when occurredAt is changed after signing — ' +
    'the signed frame never includes event.occurredAt, so the "tamper-evidence" claim does not extend to it',
  async () => {
    const original = baseEvent({ occurredAt: now });
    const signature = await publishAndCapture(original);

    // Sanity: the signature verifies against the exact original event.
    assert.equal(await verifySignedNotification(original, signature), true);

    // The attack/bug scenario: occurredAt altered, everything else identical.
    const timestampTampered: NotificationEvent = { ...original, occurredAt: later };
    const verified = await verifySignedNotification(timestampTampered, signature);
    assert.equal(
      verified,
      true,
      'occurredAt is NOT part of the signed frame — this assertion documents the current (gap) behavior; ' +
        'if this ever starts failing, the gap has been fixed and this test should be inverted',
    );
  },
);

// --- Coverage: fields that ARE covered by the signature ---

test('verifySignedNotification rejects when companyId differs (cross-company replay protection holds)', async () => {
  const original = baseEvent({ companyId: 'co-1' });
  const signature = await publishAndCapture(original);
  const otherCompany: NotificationEvent = { ...original, companyId: 'co-2' };
  assert.equal(await verifySignedNotification(otherCompany, signature), false);
});

test('verifySignedNotification rejects when subjectRef differs', async () => {
  const original = baseEvent({ subjectRef: 'issue:issue-1' });
  const signature = await publishAndCapture(original);
  const otherSubject: NotificationEvent = { ...original, subjectRef: 'issue:issue-2' };
  assert.equal(await verifySignedNotification(otherSubject, signature), false);
});

test('verifySignedNotification returns false (never throws) for a corrupted/garbage signature string', async () => {
  const original = baseEvent();
  const signature = await publishAndCapture(original);
  const corrupted: RadioMoeSignature = { ...signature, signature: 'not-a-real-signature' };
  await assert.doesNotReject(async () => {
    const verified = await verifySignedNotification(original, corrupted);
    assert.equal(verified, false);
  });
});
