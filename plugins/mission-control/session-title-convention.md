# Mission Control session titles

Use this title format when a CLI supports naming a session:

```text
DEPT/Agent: Outcome | Scope | WORK-ID
```

Examples:

```text
ENG/Atlas: Review auth boundaries | Customer Portal | KB-142
SRE/Sentinel: Diagnose API latency | Staging | INC-204
PROD/Nova: Refine onboarding acceptance | Mobile | STORY-88
RES/Curie: Compare retrieval strategies | Knowledge Platform | EXP-31
```

The outcome should describe the intended result, not a generic activity such as
"working" or "coding." Scope and the final Kanban/story reference are optional;
when a work reference is present, scope must also be present. Keep titles free of customer names,
credentials, ticket secrets, prompt text, and unrestricted filesystem paths.

Supported department codes are `ENG`, `SRE`, `PROD`, `RES`, `OPS`, `GTM`, `FIN`,
`EXEC`, `LEGAL`, `CS`, and `HR`. A different uppercase code is displayed literally.

Mission Control parses only the exact convention. A parsed title is marked
**declared**, because a session can describe its identity but cannot verify it.
The operator-owned identity directory remains authoritative and takes precedence.

For tools without named sessions, copy `identity-directory.example.json` to
`$HERMES_HOME/mission-control-identities.json` and use exact runtime, workspace,
profile, or session-ID selectors. Do not map an entire runtime to one agent when
several agents share that runtime.
