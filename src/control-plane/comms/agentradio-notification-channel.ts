import type { NotificationChannel, NotificationEvent } from '../schema/notification.js';

/**
 * Interface-only stub — HEARTBEATS-AND-COMMS.md §0 Finding D /  §5. A
 * repo-wide search for `radio-moe`/`AgentRadio` in the `ruvnet/ruflo`
 * checkout finds only the design-doc amendments this project's own session
 * wrote — no source, no matching MCP tools — and `ruvnet/autogenous` is not
 * checked out anywhere on this machine. There is nothing real to implement
 * against, so this returns `{delivered:false, degraded:true}`
 * unconditionally rather than fabricating an API call. `agentbbs` (see
 * `agentbbs-notification-channel.ts`) is the channel actually wired and
 * used this slice — a deviation from the brief's "AgentRadio primary"
 * framing, made explicit here rather than papered over.
 *
 * Whoever wires this for real needs to (a) locate an actual
 * `ruvnet/autogenous` checkout or published `packages/radio-moe` artifact,
 * (b) read its real interface the same way this codebase reads
 * `claims-tools.ts`/`agentbbs-tools.ts`/`memory-tools.ts` directly rather
 * than trusting a skill doc's summary, (c) implement this class against
 * that real interface, not this stub.
 */
export class AgentRadioNotificationChannel implements NotificationChannel {
  async publish(_event: NotificationEvent): Promise<{ delivered: boolean; degraded?: boolean }> {
    return { delivered: false, degraded: true };
  }
}
