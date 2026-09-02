# Control plane

Company → Goals → Issues schema layered on AgentDB (`schema/`), with the
approval-gate state machine (`approval/`), `claims_*`-backed and
`ActorCredential`-verified authorization (`authorization/`), budget-gated
heartbeats (`heartbeat/`), agentbbs comms with `radio-moe` signing
(`comms/`), per-`OrgMember` interaction profiles
(`employee-augmentation/`), the read-only company-board dashboard
(`dashboard/`), and the AgentDB persistence adapter (`store/`).

See `docs/design/` for the design doc behind each subdirectory (one per
slice — `DOMAIN-MODEL.md`, `APPROVAL-GATE.md`, `AUTHORIZATION.md`,
`ACTOR-IDENTITY-VERIFICATION.md`, `HUMAN-CREDENTIAL-ISSUANCE.md`,
`HEARTBEATS-AND-COMMS.md`, `EMPLOYEE-INTERACTION-PROFILE.md`,
`RUCLIP-DASHBOARD.md`; `RUCLIP-METAHARNESS.md` and
`DREAM-MACHINE-INTEGRATION.md` cover the `.harness/`/`dream.config.json`
governance tooling outside this directory) and `docs/PLAN.md` §8 for
delivery status against the phased roadmap.
