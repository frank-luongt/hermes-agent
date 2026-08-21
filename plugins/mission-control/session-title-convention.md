# Mission Control session titles

Use this title format when a CLI supports naming a session:

```text
Department/Agent Name: Job outcome | Scope | WORK-ID
```

Examples:

```text
Product/Khai Vuong: Review Even G2 applications | FAOS + FBrain | G2-014
Engineering/Kien Nguyen: Rà soát ranh giới xác thực | Customer Portal | KB-142
Company HQ/Tuan Anh Nguyen: Đánh giá ranh giới phê duyệt | Mission Control | SEC-204
Company HQ/Frank Luong: So sánh ưu tiên chiến lược | FAOS Platform | EXP-31
Sales & Marketing/Trang Nguyen: Chuẩn bị thông điệp ra mắt | Market launch | GTM-24
```

The outcome describes the intended result, not a generic activity such as
"working" or "coding." Scope and the final Kanban/story reference are optional;
when a work reference is present, scope must also be present. Keep titles free
of customer names, credentials, ticket secrets, prompt text, and unrestricted
filesystem paths.

Operator-facing titles use the English FAOSX department names: `Company HQ`,
`Wiki`, `Operations`, `Strategy`, `Finance`, `Product`, `Engineering`,
`Project`, `Sales & Marketing`, `Customer Support`, `HR`, `Legal`, and
`Investor Relations`. Stable internal IDs remain `company_hq`, `wiki`,
`operations`, `strategy`, `finance`, `products`, `engineering`, `projects`,
`sales_marketing`, `customer_support`, `hr`, `legal`, and
`investor_relations`. Legacy slugs and team codes remain readable during
migration, but new titles must use the operator-facing department name.

Agent display names should match the canonical `metadata.name` in the FAOS
`.agent.yaml` definition. The current FAOS names use unaccented Vietnamese
spelling. Mission Control derives the
corresponding FAOSX team name from the canonical department, for example
`Product` becomes `FAOSX Product`; teams do not need to repeat that
label in each identity mapping.

Mission Control parses only the exact convention. A parsed title is marked
**declared**, because a session can describe its identity but cannot verify it.
The operator-owned identity directory remains authoritative and takes
precedence. The local telemetry window is the latest 10 days; active sessions
remain visible even when a runtime cannot report a reliable timestamp.

For tools without named sessions, copy `identity-directory.example.json` to
`$HERMES_HOME/mission-control-identities.json` and use exact runtime, workspace,
profile, or session-ID selectors. Session-specific mappings may also supply
`job`, `scope`, and `workRef`. Do not map an entire runtime to one agent when
several agents share that runtime.
