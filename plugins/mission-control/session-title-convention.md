# Mission Control session titles

Use this title format when a CLI supports naming a session:

```text
faosx_department/Agent: Outcome | Scope | WORK-ID
```

Examples:

```text
engineering/Minh Quân: Rà soát ranh giới xác thực | Customer Portal | KB-142
operations/Bảo An: Chẩn đoán độ trễ API | Staging | INC-204
products/Ngọc Mai: Hoàn thiện tiêu chí onboarding | Mobile | STORY-88
strategy/Gia Hưng: So sánh chiến lược truy xuất | Knowledge Platform | EXP-31
sales_marketing/Khánh Linh: Chuẩn bị thông điệp ra mắt | Market launch | GTM-24
```

The outcome describes the intended result, not a generic activity such as
"working" or "coding." Scope and the final Kanban/story reference are optional;
when a work reference is present, scope must also be present. Keep titles free
of customer names, credentials, ticket secrets, prompt text, and unrestricted
filesystem paths.

The canonical FAOSX departments are `company_hq`, `wiki`, `operations`,
`strategy`, `finance`, `products`, `engineering`, `projects`,
`sales_marketing`, `customer_support`, `hr`, `legal`, and
`investor_relations`. Legacy team codes remain readable during migration but
new titles must use a canonical department slug.

Agent display names may use Vietnamese Unicode. Mission Control derives the
corresponding FAOSX team name from the canonical department, for example
`engineering` becomes `FAOSX Đội Kỹ thuật`; teams do not need to repeat that
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
