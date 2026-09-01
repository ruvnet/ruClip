/**
 * AgentDB persistence adapter for Company/OrgMember/Goal/Issue/Comment
 * (DOMAIN-MODEL.md §2). Implements the hierarchical-store tier placement,
 * causal-edge relations, and pattern-store namespaces the domain model
 * specifies.
 *
 * CLI-surface finding (this is the documented deviation the coder-stage
 * brief asked for): `npx ruflo agentdb ...` does **not exist** as a CLI
 * subcommand. Checked v3/@claude-flow/cli/src/commands/*.ts directly — the
 * only CLI surface is `ruflo memory <store|retrieve|search|list|delete|...>`
 * (v3/@claude-flow/cli/src/commands/memory.ts), which is a much thinner
 * key/namespace/value API than what this schema needs (no tiers, no causal
 * edges, no graph queries, no pattern-store namespaces). The richer
 * `agentdb_*` primitives this file depends on
 * (hierarchical-store/recall/delete, causal-edge, graph-query,
 * pattern-store/search) exist ONLY as MCP tools
 * (v3/@claude-flow/cli/src/mcp-tools/agentdb-tools.ts) — they are not
 * exposed as `ruflo <verb>` CLI commands anywhere in that package.
 *
 * Since this repo is a plain Node module (not a Claude Code session), it
 * cannot call `mcp__*__agentdb_*` tools directly either. The path that
 * actually exists end-to-end is the HTTP JSON-RPC bridge started by
 * `ruflo mcp start -t http -p <port>` (verified against
 * v3/@claude-flow/cli/src/mcp-server.ts `handleMCPMessage`): POST
 * `{jsonrpc:"2.0", method:"tools/call", params:{name, arguments}}` to
 * `http://<host>:<port>/rpc` and unwrap `result.content[0].text` (JSON).
 * This module talks to that bridge. A deployment must run
 * `ruflo mcp start -t http` as a sidecar before this adapter's functions
 * will succeed; `RUCLIP_AGENTDB_BRIDGE_URL` overrides the default
 * `http://localhost:3000`.
 *
 * Two further deviations from DOMAIN-MODEL.md §2, discovered by reading the
 * real tool schemas rather than guessing:
 *
 * 1. §2.3 says cycle prevention runs `agentdb_graph-pathfinder` from the
 *    proposed target back to the proposed source. The real
 *    `agentdb_graph-pathfinder` tool takes `{seedNodeId, query}` and returns
 *    algorithm-ranked paths (personalized-pagerank / mincut / spectral /
 *    etc.) scored against a natural-language query — it has no
 *    `targetNodeId` and is not a deterministic "does a path exist" check.
 *    `agentdb_graph-query` with `mode:'k-hop'` + a `relation` filter IS a
 *    deterministic bounded neighbor expansion, so cycle prevention here
 *    walks k-hop from the proposed target and checks whether the proposed
 *    source appears in the reachable set. See `wouldCreateCycle` below.
 * 2. `agentdb_pattern-store`/`agentdb_pattern-search` have no `namespace`
 *    parameter (only `pattern`, `type`, `confidence` / `query`, `topK`,
 *    `minConfidence`). The three namespaces DOMAIN-MODEL.md §2.4 describes
 *    (`ruclip/org-chart`, `ruclip/issue-templates`,
 *    `ruclip/approval-heuristics`) are encoded into the `type` field
 *    instead, since that's the only discriminator the real tool exposes.
 *
 * Node IDs used in causal-edge/graph-query calls are prefixed `entity:` to
 * land in agentdb-tools.ts's ADR-130 `VALID_DOMAINS` set and avoid its
 * legacy-ID auto-prefix warning.
 */
import type { Company } from '../schema/company.js';
import type { OrgMember } from '../schema/org-member.js';
import type { Goal } from '../schema/goal.js';
import type { Issue } from '../schema/issue.js';
import type { Comment } from '../schema/comment.js';
import type { CausalRelation, MemoryTier } from '../schema/enums.js';
import {
  assertValidCompany,
  assertValidOrgMember,
  assertValidGoal,
  assertValidIssue,
  assertValidComment,
} from '../schema/validation.js';

export class AgentDbBridgeError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AgentDbBridgeError';
  }
}

export interface AgentDbAdapterConfig {
  /** Base URL of a `ruflo mcp start -t http` server. Defaults to RUCLIP_AGENTDB_BRIDGE_URL or http://localhost:3000. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

function resolveBaseUrl(config?: AgentDbAdapterConfig): string {
  return config?.baseUrl ?? process.env.RUCLIP_AGENTDB_BRIDGE_URL ?? 'http://localhost:3000';
}

let rpcIdCounter = 0;

async function callTool<T = unknown>(
  name: string,
  args: Record<string, unknown>,
  config?: AgentDbAdapterConfig,
): Promise<T> {
  const fetchFn = config?.fetchImpl ?? fetch;
  const baseUrl = resolveBaseUrl(config);
  let response: Response;
  try {
    response = await fetchFn(`${baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `ruclip-${Date.now()}-${rpcIdCounter++}`,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
  } catch (err) {
    throw new AgentDbBridgeError(
      `Could not reach AgentDB MCP bridge at ${baseUrl}/rpc — is 'ruflo mcp start -t http' running?`,
      err,
    );
  }
  if (!response.ok) {
    throw new AgentDbBridgeError(`AgentDB bridge HTTP ${response.status} calling ${name}`);
  }
  const payload = (await response.json()) as {
    error?: { code: number; message: string };
    result?: { content?: Array<{ type: string; text: string }> };
  };
  if (payload.error) {
    throw new AgentDbBridgeError(`AgentDB tool '${name}' failed: ${payload.error.message}`);
  }
  const text = payload.result?.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new AgentDbBridgeError(`AgentDB tool '${name}' returned no content`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new AgentDbBridgeError(`AgentDB tool '${name}' returned non-JSON content`, err);
  }
}

// --- Keying (DOMAIN-MODEL.md §2.2) ---------------------------------------

export function companyKey(companyId: string): string {
  return `ruclip:company:${companyId}`;
}
export function orgMemberKey(companyId: string, orgMemberId: string): string {
  return `ruclip:company:${companyId}:org-member:${orgMemberId}`;
}
export function goalKey(companyId: string, goalId: string): string {
  return `ruclip:company:${companyId}:goal:${goalId}`;
}
export function issueKey(companyId: string, goalId: string, issueId: string): string {
  return `ruclip:company:${companyId}:goal:${goalId}:issue:${issueId}`;
}
export function commentKey(companyId: string, goalId: string, issueId: string, commentId: string): string {
  return `${issueKey(companyId, goalId, issueId)}:comment:${commentId}`;
}

/** ADR-130 domain-prefixed node id for causal-edge / graph-query calls. */
function entityNodeId(kind: 'company' | 'org-member' | 'goal' | 'issue', id: string): string {
  return `entity:${kind}:${id}`;
}

/** DOMAIN-MODEL.md §2.1 — an issue's tier is derived from its status. */
export function tierForIssueStatus(status: Issue['status']): MemoryTier {
  return status === 'done' || status === 'cancelled' ? 'episodic' : 'working';
}

// --- Generic hierarchical-store wrappers ----------------------------------

async function storeAtTier(
  key: string,
  value: unknown,
  tier: MemoryTier,
  config?: AgentDbAdapterConfig,
): Promise<void> {
  await callTool('agentdb_hierarchical-store', { key, value: JSON.stringify(value), tier }, config);
}

async function deleteFromTier(key: string, tier: MemoryTier, config?: AgentDbAdapterConfig): Promise<void> {
  await callTool('agentdb_hierarchical-delete', { key, tier }, config);
}

/**
 * Recall by exact key. agentdb_hierarchical-recall is a semantic/BM25 search
 * over `query`, not an exact-key get — we search with the key as the query
 * and defensively keep only a result whose own key matches exactly.
 */
async function recallByKey<T>(
  key: string,
  tier: MemoryTier | undefined,
  config?: AgentDbAdapterConfig,
): Promise<T | null> {
  const result = await callTool<{ results?: Array<{ key?: string; id?: string; value?: string }> }>(
    'agentdb_hierarchical-recall',
    { query: key, tier, topK: 10 },
    config,
  );
  const match = (result.results ?? []).find((r) => r.key === key || r.id === key);
  if (!match || typeof match.value !== 'string') return null;
  try {
    return JSON.parse(match.value) as T;
  } catch {
    return null;
  }
}

// --- Causal edges (DOMAIN-MODEL.md §2.3) ----------------------------------

const CYCLE_CHECKED_RELATIONS: readonly CausalRelation[] = ['parent_of', 'reports_to'];

/**
 * Deterministic k-hop reachability check (see file header for why this
 * replaces the domain model's graph-pathfinder suggestion). Returns true if
 * `candidateSourceId` is reachable from `candidateTargetId` by following
 * `relation` edges — i.e. adding `candidateSourceId -> candidateTargetId`
 * would close a cycle.
 */
async function wouldCreateCycle(
  candidateSourceId: string,
  candidateTargetId: string,
  relation: CausalRelation,
  config?: AgentDbAdapterConfig,
): Promise<boolean> {
  const result = await callTool<{ nodes?: Array<{ id: string }> }>(
    'agentdb_graph-query',
    { nodeId: candidateTargetId, mode: 'k-hop', relation, depth: 5 },
    config,
  );
  return (result.nodes ?? []).some((n) => n.id === candidateSourceId);
}

/**
 * Record a causal edge, enforcing DOMAIN-MODEL.md §1.2/§1.4 cycle
 * prevention for `parent_of` and `reports_to`.
 */
export async function recordCausalEdge(
  sourceId: string,
  targetId: string,
  relation: CausalRelation,
  config?: AgentDbAdapterConfig,
): Promise<void> {
  if (CYCLE_CHECKED_RELATIONS.includes(relation)) {
    if (sourceId === targetId) {
      throw new AgentDbBridgeError(`Refusing self-referential ${relation} edge on ${sourceId}`);
    }
    if (await wouldCreateCycle(sourceId, targetId, relation, config)) {
      throw new AgentDbBridgeError(
        `Refusing ${relation} edge ${sourceId} -> ${targetId}: would close a cycle`,
      );
    }
  }
  await callTool('agentdb_causal-edge', { sourceId, targetId, relation, weight: 1.0 }, config);
}

/** k-hop neighbors of `nodeId` following `relation`, one hop, as raw entity ids. */
async function graphNeighbors(
  nodeId: string,
  relation: CausalRelation,
  config?: AgentDbAdapterConfig,
): Promise<string[]> {
  const result = await callTool<{ nodes?: Array<{ id: string }> }>(
    'agentdb_graph-query',
    { nodeId, mode: 'k-hop', relation, depth: 1 },
    config,
  );
  return (result.nodes ?? []).map((n) => n.id);
}

// --- Company ---------------------------------------------------------------

export async function persistCompany(company: Company, config?: AgentDbAdapterConfig): Promise<void> {
  assertValidCompany(company);
  await storeAtTier(companyKey(company.id), company, 'semantic', config);
}

export async function recallCompany(companyId: string, config?: AgentDbAdapterConfig): Promise<Company | null> {
  return recallByKey<Company>(companyKey(companyId), 'semantic', config);
}

// --- OrgMember ---------------------------------------------------------------

export async function persistOrgMember(member: OrgMember, config?: AgentDbAdapterConfig): Promise<void> {
  assertValidOrgMember(member);
  await storeAtTier(orgMemberKey(member.companyId, member.id), member, 'semantic', config);
  if (member.managerId) {
    await recordCausalEdge(
      entityNodeId('org-member', member.id),
      entityNodeId('org-member', member.managerId),
      'reports_to',
      config,
    );
  }
}

export async function recallOrgMember(
  companyId: string,
  orgMemberId: string,
  config?: AgentDbAdapterConfig,
): Promise<OrgMember | null> {
  return recallByKey<OrgMember>(orgMemberKey(companyId, orgMemberId), 'semantic', config);
}

// --- Goal ---------------------------------------------------------------

export async function persistGoal(goal: Goal, config?: AgentDbAdapterConfig): Promise<void> {
  assertValidGoal(goal);
  await storeAtTier(goalKey(goal.companyId, goal.id), goal, 'semantic', config);
  await recordCausalEdge(entityNodeId('goal', goal.id), entityNodeId('company', goal.companyId), 'belongs_to', config);
}

export async function recallGoal(
  companyId: string,
  goalId: string,
  config?: AgentDbAdapterConfig,
): Promise<Goal | null> {
  return recallByKey<Goal>(goalKey(companyId, goalId), 'semantic', config);
}

// --- Issue ---------------------------------------------------------------

/**
 * Persist an issue at the tier its status implies. When `previousStatus` is
 * given and its tier differs from the new status's tier, the stale copy is
 * removed from the old tier in the same call — DOMAIN-MODEL.md §2.1's "an
 * issue's tier changes exactly once, in the write that closes it."
 */
export async function persistIssue(
  companyId: string,
  issue: Issue,
  previousStatus?: Issue['status'],
  config?: AgentDbAdapterConfig,
): Promise<void> {
  assertValidIssue(issue);
  const key = issueKey(companyId, issue.goalId, issue.id);
  const tier = tierForIssueStatus(issue.status);
  await storeAtTier(key, issue, tier, config);
  if (previousStatus) {
    const previousTier = tierForIssueStatus(previousStatus);
    if (previousTier !== tier) {
      await deleteFromTier(key, previousTier, config);
    }
  }
  await recordCausalEdge(entityNodeId('issue', issue.id), entityNodeId('goal', issue.goalId), 'belongs_to', config);
  if (issue.parentId) {
    await recordCausalEdge(
      entityNodeId('issue', issue.parentId),
      entityNodeId('issue', issue.id),
      'parent_of',
      config,
    );
  }
  if (issue.assigneeId) {
    await recordCausalEdge(
      entityNodeId('issue', issue.id),
      entityNodeId('org-member', issue.assigneeId),
      'assigned_to',
      config,
    );
  }
}

/** Looks in the working tier first (the common case), falling back to episodic for closed issues. */
export async function recallIssue(
  companyId: string,
  goalId: string,
  issueId: string,
  config?: AgentDbAdapterConfig,
): Promise<Issue | null> {
  const key = issueKey(companyId, goalId, issueId);
  return (
    (await recallByKey<Issue>(key, 'working', config)) ?? (await recallByKey<Issue>(key, 'episodic', config))
  );
}

/** DOMAIN-MODEL.md §1.4 `blocks` edge — no cycle check (blocking isn't a tree relation). */
export async function addBlocksEdge(
  blockerIssueId: string,
  blockedIssueId: string,
  config?: AgentDbAdapterConfig,
): Promise<void> {
  await recordCausalEdge(entityNodeId('issue', blockerIssueId), entityNodeId('issue', blockedIssueId), 'blocks', config);
}

/** Issue ids of open blockers pointing at `issueId` — feeds the §1.4 progress-gate invariant (enforced downstream). */
export async function getBlockerIssueIds(issueId: string, config?: AgentDbAdapterConfig): Promise<string[]> {
  const neighbors = await graphNeighbors(entityNodeId('issue', issueId), 'blocks', config);
  return neighbors
    .filter((id) => id.startsWith('entity:issue:'))
    .map((id) => id.slice('entity:issue:'.length));
}

/** Child issue ids — derived via `parent_of`, never stored on the Issue document (DOMAIN-MODEL.md §1.4). */
export async function getChildIssueIds(issueId: string, config?: AgentDbAdapterConfig): Promise<string[]> {
  const neighbors = await graphNeighbors(entityNodeId('issue', issueId), 'parent_of', config);
  return neighbors
    .filter((id) => id.startsWith('entity:issue:'))
    .map((id) => id.slice('entity:issue:'.length));
}

// --- Comment ---------------------------------------------------------------

/** Comments are stored at their parent issue's current tier (DOMAIN-MODEL.md §2.1). */
export async function persistComment(
  companyId: string,
  goalId: string,
  comment: Comment,
  issueTier: MemoryTier,
  config?: AgentDbAdapterConfig,
): Promise<void> {
  assertValidComment(comment);
  await storeAtTier(commentKey(companyId, goalId, comment.issueId, comment.id), comment, issueTier, config);
}

// --- Pattern-store (DOMAIN-MODEL.md §2.4) -----------------------------------

/** The three advisory namespaces from DOMAIN-MODEL.md §2.4, encoded into `type` (see file header, deviation 2). */
export type RuclipPatternNamespace =
  | 'ruclip/org-chart'
  | 'ruclip/issue-templates'
  | 'ruclip/approval-heuristics';

export async function storePattern(
  namespace: RuclipPatternNamespace,
  pattern: string,
  confidence = 0.8,
  config?: AgentDbAdapterConfig,
): Promise<void> {
  await callTool('agentdb_pattern-store', { pattern, type: namespace, confidence }, config);
}

export interface PatternSearchResult {
  pattern: string;
  type: string;
  confidence: number;
}

export async function searchPatterns(
  namespace: RuclipPatternNamespace,
  query: string,
  topK = 5,
  config?: AgentDbAdapterConfig,
): Promise<PatternSearchResult[]> {
  const result = await callTool<{ results?: PatternSearchResult[] }>(
    'agentdb_pattern-search',
    { query: `${namespace} ${query}`, topK },
    config,
  );
  return (result.results ?? []).filter((r) => r.type === namespace);
}
