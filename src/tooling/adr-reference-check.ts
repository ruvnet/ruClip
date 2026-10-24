/**
 * Dev-tooling: catch dangling internal ADR-NNN citations before they rot.
 *
 * ruClip's source/docs cite architecture decisions two ways: its own
 * (must resolve to a real `docs/adr/ADR-*.md` file) and other repos'/tools'
 * (`ruvnet/autogenous`, `cognitum-one/slack`, the agentdb/metaharness tool
 * schemas themselves — each already confirmed external by an inline
 * citation or ADR-0001's own `## Links` section). This module tells the
 * two apart with a fixed, disclosed allowlist of confirmed-external ids
 * (`EXTERNAL_ADR_IDS`), not automatic attribution-sniffing — same
 * non-recursive, disclosed-limitation shape as this repo's other
 * dream-cycle tooling checks. Research backing the allowlist is recorded in
 * `docs/dream-cycle/2026-10-24-developer-experience-report.md`.
 *
 * Disclosed limitation: a new external ADR-NNN citation added later without
 * a matching `EXTERNAL_ADR_IDS` entry will show up here as a false "broken
 * internal reference" until the allowlist is updated — this checker does
 * not infer attribution from surrounding prose.
 */

export interface AdrMention {
  /** Normalized id, e.g. "ADR-9" and "ADR-0009" both become "ADR-9". */
  adrId: string;
  file: string;
  line: number;
  excerpt: string;
}

export interface AdrReferenceReport {
  internalMentions: AdrMention[];
  brokenInternalMentions: AdrMention[];
  externalMentionsSkipped: AdrMention[];
  ok: boolean;
}

export interface SourceFile {
  path: string;
  content: string;
}

const ADR_MENTION_RE = /ADR-(\d{2,4})\b/g;

function normalizeAdrId(raw: string): string {
  const digits = raw.replace(/^ADR-0*/, '');
  return `ADR-${digits === '' ? '0' : digits}`;
}

/** Confirmed external (owner-repo or third-party-tool-schema) ADR ids — see file header. */
export const EXTERNAL_ADR_IDS: ReadonlySet<string> = new Set(
  [
    // cognitum-one/slack's own ADR corpus (docs/design/HUMAN-CREDENTIAL-ISSUANCE-PRODUCER.md:
    // "Read directly (via `gh api`, private-repo read access): all 20 ADRs.").
    2, 9, 15, 16,
    // External systems ruClip reuses patterns from, per ADR-0001's own `## Links`
    // section and the inline citations at their call sites: witness (103),
    // MetaHarness integration surfaces (150), agentbbs federation (164).
    103, 150, 164,
    // agentdb-tools.ts's own VALID_DOMAINS decision (store/agentdb-adapter.ts).
    130,
    // The real agentdb MCP bridge tool's own provenance_type schema/description
    // (src/control-plane/employee-augmentation/interaction-profile.ts, confirmed
    // against the tool's own description string, not a ruClip decision).
    323,
    // ruvnet/autogenous (radio-moe) — "ADR-390 through ADR-395-402" per
    // ADR-0001's `## Links` section.
    390, 391, 392, 393, 394, 395, 396, 397, 398, 399, 400, 401, 402,
  ].map((n) => `ADR-${n}`),
);

export function findAdrMentions(file: string, content: string): AdrMention[] {
  const mentions: AdrMention[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const match of line.matchAll(ADR_MENTION_RE)) {
      mentions.push({
        adrId: normalizeAdrId(match[0]),
        file,
        line: i + 1,
        excerpt: line.trim(),
      });
    }
  }
  return mentions;
}

/** `existingAdrIds` and `externalAdrIds` must already be normalized via `normalizeAdrId`. */
export function checkAdrReferences(
  files: readonly SourceFile[],
  existingAdrIds: ReadonlySet<string>,
  externalAdrIds: ReadonlySet<string> = EXTERNAL_ADR_IDS,
): AdrReferenceReport {
  const internalMentions: AdrMention[] = [];
  const externalMentionsSkipped: AdrMention[] = [];
  for (const { path, content } of files) {
    for (const mention of findAdrMentions(path, content)) {
      if (externalAdrIds.has(mention.adrId)) {
        externalMentionsSkipped.push(mention);
      } else {
        internalMentions.push(mention);
      }
    }
  }
  const brokenInternalMentions = internalMentions.filter(
    (m) => !existingAdrIds.has(m.adrId),
  );
  return {
    internalMentions,
    brokenInternalMentions,
    externalMentionsSkipped,
    ok: brokenInternalMentions.length === 0,
  };
}

/** Parses `docs/adr/ADR-0001-foo.md`-style filenames into normalized ids. */
export function adrIdFromFilename(filename: string): string | null {
  const match = /^ADR-(\d{2,4})-/.exec(filename);
  return match ? normalizeAdrId(`ADR-${match[1]}`) : null;
}

export function formatReport(report: AdrReferenceReport): string {
  if (report.ok) {
    return `OK: ${report.internalMentions.length} internal ADR citation(s) checked, 0 broken (${report.externalMentionsSkipped.length} external citation(s) skipped via allowlist).`;
  }
  const lines = [
    `BROKEN: ${report.brokenInternalMentions.length} internal ADR citation(s) have no matching docs/adr/ file:`,
  ];
  for (const m of report.brokenInternalMentions) {
    lines.push(`  ${m.adrId}  ${m.file}:${m.line}  ${m.excerpt}`);
  }
  return lines.join('\n');
}
