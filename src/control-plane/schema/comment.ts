export interface Comment {
  id: string;
  issueId: string;
  /** OrgMember.id of the author — agent or human. */
  authorId: string;
  body: string;
  createdAt: string; // ISO 8601
  // Immutable once written — no updatedAt, no edit/delete in v1.
}
