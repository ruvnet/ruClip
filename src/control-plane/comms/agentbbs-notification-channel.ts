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
 */
import { callTool, assertSafeId, type AgentDbAdapterConfig } from '../store/bridge-client.js';
import type { NotificationChannel, NotificationEvent, NotificationKind } from '../schema/notification.js';

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
    const result = await callTool<FederationBbsPublishResult>(
      'federation_bbs_publish',
      {
        roomId: this.roomId,
        msgType: MSG_TYPE_BY_KIND[event.kind],
        payload: { ...event.payload, subjectRef: event.subjectRef, occurredAt: event.occurredAt },
      },
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
