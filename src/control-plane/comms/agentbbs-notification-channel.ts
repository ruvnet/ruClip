/**
 * Real NotificationChannel implementation over ruflo's live
 * `federation_bbs_*` MCP tools (HEARTBEATS-AND-COMMS.md §5, verified
 * against v3/@claude-flow/cli/src/mcp-tools/agentbbs-tools.ts directly —
 * this repo never imports it, only calls the MCP bridge, same discipline
 * as the rest of this adapter). `agentbbs` is an optional dependency —
 * every `federation_bbs_*` tool degrades to `{success:true, degraded:true,
 * reason:'agentbbs-not-found'}` (note: `success` stays `true` on
 * degradation, unlike `claims_*`'s `success:false` failure convention —
 * `degraded` is the field to check here, not `success`).
 *
 * Optional radio-moe signing layer (revision of HEARTBEATS-AND-COMMS.md §5
 * after the AgentRadio correction — see docs/design/HEARTBEATS-AND-COMMS.md
 * §0 Finding D's second revision). `radio-moe@0.3.1` and
 * `@metaharness/radio@0.1.0` ARE real, published, well-tested npm packages
 * (confirmed via `npm view` and by reading the installed `dist/*.d.ts`
 * directly, not just the README) — the earlier "zero implementation
 * surface" finding was wrong about that. But neither package's real API is
 * a notification/pub-sub bus: `@metaharness/radio`'s `RadioBus`/`Watcher`
 * is in-process, single-task awareness that its own docs say "never
 * crosses the network"; radio-moe's real signed wire protocol
 * (`Wire = AdvertWire | DispatchWire | LogitFrame | TextFrame`, verified in
 * `dist/types.d.ts`) is a closed union with no notification-shaped
 * variant, built for its actual job — mixture-of-experts routing/dispatch/
 * streaming — and `Peer`'s only public methods are `host(expert)` and
 * `route(chunk, kind)`, no generic broadcast. So this is NOT a standalone
 * `AgentRadioNotificationChannel implements NotificationChannel` (that
 * would force one of radio-moe's real primitives into a job it doesn't do,
 * the same category of fabrication this codebase has consistently avoided
 * — e.g. stuffing notification JSON into `TextFrame.tokens`, a field
 * radio-moe's real `Peer.route()` machinery expects to mean something
 * specific).
 *
 * What radio-moe DOES do for real, correctly used here: `PeerIdentity` +
 * `signFrame`/`verifyFrame` give ANY payload a genuine ed25519 signature —
 * this file uses that (and only that) to add tamper-evidence/provenance to
 * every notification, still delivered over the one real, working,
 * cross-process channel this environment has for arbitrary payloads:
 * agentbbs's `federation_bbs_publish`. There is no MCP tool wrapping
 * radio-moe's signing primitives (checked: no `radio-moe`/`AgentRadio`
 * reference anywhere in `v3/@claude-flow/cli/src/mcp-tools/`), so — unlike
 * every other integration in this file, which only ever talks to
 * `bridge-client.ts`'s `callTool` — signing requires a genuine, direct
 * `import('radio-moe')` in this repo's own process. `radio-moe` is an
 * OPTIONAL peer dependency (package.json, same ADR-150 pattern as
 * `agentbbs`): when it isn't installed, signing is silently skipped and
 * `publish` behaves exactly as it did before this revision — no behavior
 * change for a deployment that never installs it. (It's also a
 * `devDependency` here, pinned to the same real published version, purely
 * so this repo's OWN test suite can exercise the real signed path
 * deterministically — that does not make it a hard runtime dependency of
 * anything this package ships.)
 */
import { callTool, assertSafeId, type AgentDbAdapterConfig } from '../store/bridge-client.js';
import type { NotificationChannel, NotificationEvent, NotificationKind } from '../schema/notification.js';

// --- Optional radio-moe signing (see file header) ---------------------------

interface RadioMoeModule {
  PeerIdentity: {
    generate(): { peerId: string; publicKeyDer: Buffer };
  };
  signFrame(
    identity: { peerId: string; publicKeyDer: Buffer },
    frame: Record<string, unknown>,
  ): { signature: string };
  verifyFrame(frame: Record<string, unknown>, publicKeyDerHex: string): boolean;
}

let _radioMoeMod: RadioMoeModule | false | null = null;
let _radioMoeLoadAttempted = false;

async function loadRadioMoe(): Promise<RadioMoeModule | null> {
  if (_radioMoeLoadAttempted) return _radioMoeMod || null;
  _radioMoeLoadAttempted = true;
  try {
    _radioMoeMod = (await import('radio-moe')) as unknown as RadioMoeModule;
    return _radioMoeMod;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (
      e?.code === 'ERR_MODULE_NOT_FOUND' ||
      e?.code === 'MODULE_NOT_FOUND' ||
      /Cannot find (module|package)/i.test(String(e?.message))
    ) {
      _radioMoeMod = false;
      return null;
    }
    throw err;
  }
}

/**
 * Ephemeral per-process ed25519 identity for signing outbound
 * notifications. Not persisted across restarts, nothing about the private
 * key is ever logged or exposed — mirrors the exact pattern
 * v3/@claude-flow/cli/src/mcp-tools/agentbbs-tools.ts's own
 * `getSigningKey()` already uses for human-join tokens elsewhere in this
 * monorepo.
 */
let _signingIdentity: { peerId: string; publicKeyDer: Buffer } | null = null;

function getSigningIdentity(radioMoe: RadioMoeModule): { peerId: string; publicKeyDer: Buffer } {
  if (!_signingIdentity) {
    _signingIdentity = radioMoe.PeerIdentity.generate();
  }
  return _signingIdentity;
}

/**
 * The exact frame shape signed/verified — kept in one place so signing and
 * verification never drift apart.
 *
 * Security-hardening correction (security review round 5): the original
 * version of this frame omitted `event.occurredAt` entirely, even though
 * `publish()` ships it in the outbound payload alongside the signature.
 * That meant `verifySignedNotification` returned `true` for an event whose
 * `occurredAt` had been altered after signing, as long as
 * subjectRef/kind/companyId/payload were unchanged — a receiver reasonably
 * trusting "verified === true" would be wrong about *when* the event
 * happened, which is exactly the kind of fact an audit-trail signature must
 * cover (confirmed exploitable by an independent test,
 * tests/control-plane/agentradio-signing-gaps.test.ts). `occurredAt` is now
 * part of the signed `value`, so tampering with it invalidates the
 * signature like every other field this frame covers.
 */
function notificationFrame(event: NotificationEvent): Record<string, unknown> {
  return {
    requestId: event.subjectRef,
    agentId: 'ruclip',
    step: 0,
    kind: 'evidence',
    value: { kind: event.kind, companyId: event.companyId, payload: event.payload, occurredAt: event.occurredAt },
    confidence: 1,
    uncertainty: 0,
    dependencies: [],
    capabilityUsed: 'ruclip.notification',
    evidenceHashes: [],
    cost: 0,
  };
}

export interface RadioMoeSignature {
  signature: string;
  publicKeyDerHex: string;
  peerId: string;
}

/** Signs `event` with a real radio-moe AgentFrame signature. Returns null when radio-moe isn't installed — never throws for that reason. */
async function signEventIfPossible(event: NotificationEvent): Promise<RadioMoeSignature | null> {
  const radioMoe = await loadRadioMoe();
  if (!radioMoe) return null;
  const identity = getSigningIdentity(radioMoe);
  const { signature } = radioMoe.signFrame(identity, notificationFrame(event));
  return { signature, publicKeyDerHex: identity.publicKeyDer.toString('hex'), peerId: identity.peerId };
}

/**
 * Verifies a `RadioMoeSignature` against the `NotificationEvent` it was
 * signed for. Returns `false` (not a throw) when radio-moe isn't installed
 * on the verifying side — a receiver without radio-moe simply cannot
 * confirm provenance, matching this file's own degrade-don't-throw
 * convention.
 */
export async function verifySignedNotification(
  event: NotificationEvent,
  signature: RadioMoeSignature,
): Promise<boolean> {
  const radioMoe = await loadRadioMoe();
  if (!radioMoe) return false;
  const frame = { ...notificationFrame(event), signature: signature.signature };
  return radioMoe.verifyFrame(frame, signature.publicKeyDerHex);
}

/** federation_bbs_publish's real, closed msgType vocabulary — HEARTBEATS-AND-COMMS.md §5 table. */
const MSG_TYPE_BY_KIND: Record<NotificationKind, string> = {
  'heartbeat-fired': 'pod-status',
  'heartbeat-budget-blocked': 'alert',
  'issue-approval-transition': 'alert',
  'budget-threshold-crossed': 'alert',
};

interface FederationBbsPublishResult {
  success?: boolean;
  degraded?: boolean;
  envelopeId?: string;
  error?: string;
}

export class AgentBbsNotificationChannel implements NotificationChannel {
  constructor(private readonly roomId: string, private readonly bridgeConfig?: AgentDbAdapterConfig) {}

  async publish(event: NotificationEvent): Promise<{ delivered: boolean; degraded?: boolean }> {
    const signature = await signEventIfPossible(event);
    const payload: Record<string, unknown> = {
      ...event.payload,
      subjectRef: event.subjectRef,
      occurredAt: event.occurredAt,
    };
    if (signature) {
      payload.radioMoeSignature = signature;
    }
    const result = await callTool<FederationBbsPublishResult>(
      'federation_bbs_publish',
      { roomId: this.roomId, msgType: MSG_TYPE_BY_KIND[event.kind], payload },
      this.bridgeConfig,
    );
    if (result.degraded) {
      return { delivered: false, degraded: true };
    }
    return { delivered: result.success === true && typeof result.envelopeId === 'string' };
  }
}

interface FederationBbsRegisterResult {
  success?: boolean;
  degraded?: boolean;
  roomId?: string;
  nodeId?: string;
}

/**
 * One-time setup per company (HEARTBEATS-AND-COMMS.md §5): registers (or
 * idempotently re-registers) `#ruclip-{companyId}` and persists the mapping
 * as a small config record — not a field on `Company` itself, to avoid
 * touching the already-shipped `Company` interface for an
 * infrastructure-wiring detail.
 */
export async function registerCompanyCommsRoom(
  companyId: string,
  config?: AgentDbAdapterConfig,
): Promise<{ roomId: string; degraded: boolean }> {
  assertSafeId(companyId, 'companyId');
  const result = await callTool<FederationBbsRegisterResult>(
    'federation_bbs_register',
    { roomLabel: `#ruclip-${companyId}` },
    config,
  );
  if (result.degraded || !result.roomId) {
    return { roomId: '', degraded: true };
  }
  await callTool(
    'agentdb_hierarchical-store',
    {
      key: `ruclip:company:${companyId}:comms-room`,
      value: JSON.stringify({
        roomId: result.roomId,
        roomLabel: `#ruclip-${companyId}`,
        registeredAt: new Date().toISOString(),
      }),
      tier: 'semantic',
    },
    config,
  );
  return { roomId: result.roomId, degraded: false };
}

interface FederationBbsHumanJoinResult {
  success?: boolean;
  degraded?: boolean;
  webUrl?: string;
  sshCommand?: string;
  handshakeToken?: string;
  expiresAt?: string;
}

export type HumanCommsAccess =
  | { degraded: false; webUrl: string; sshCommand: string; handshakeToken: string; expiresAt: string }
  | { degraded: true };

/**
 * Mints scoped, time-limited human access to a company's comms room
 * (HEARTBEATS-AND-COMMS.md §5) — a separate helper, not auto-called by the
 * heartbeat/approval flows.
 */
export async function mintHumanCommsAccess(
  roomId: string,
  ttlSeconds?: number,
  config?: AgentDbAdapterConfig,
): Promise<HumanCommsAccess> {
  const result = await callTool<FederationBbsHumanJoinResult>('federation_bbs_human_join', { roomId, ttlSeconds }, config);
  if (result.degraded || !result.webUrl || !result.sshCommand || !result.handshakeToken || !result.expiresAt) {
    return { degraded: true };
  }
  return {
    degraded: false,
    webUrl: result.webUrl,
    sshCommand: result.sshCommand,
    handshakeToken: result.handshakeToken,
    expiresAt: result.expiresAt,
  };
}
