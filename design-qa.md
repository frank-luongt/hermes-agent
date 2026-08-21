# Mission Control Design QA

final result: passed

## Comparison target

- Source visual truth:
  - `/private/tmp/hermes-mission-control-reference-20260820/design_handoff_agent_command_center/screenshots/01-dark-default.png`
  - `/private/tmp/hermes-mission-control-reference-20260820/design_handoff_agent_command_center/screenshots/03-light-agent-selected.png`
- Browser-rendered implementation:
  - `/private/tmp/mission-control-dark-924x540-final.png`
  - `/private/tmp/mission-control-light-924x540-final-v2.png`
  - `/private/tmp/mission-control-desktop-inspector-1440x900.png`
  - `/private/tmp/mission-control-mobile-390x844-final.png`
- Full-view comparison evidence:
  - `/private/tmp/mission-control-dark-comparison-final.png`
  - `/private/tmp/mission-control-light-comparison-final.png`
- Route: `https://frank-macbook-pro.tail6cedf7.ts.net:8443/mission-control`

## Viewport and normalization

- Source pixels: 924 x 540 for both dark and light captures.
- Implementation pixels: 924 x 540 at a 924 x 540 CSS viewport for the direct comparisons.
- Density: 1:1 pixel comparison; no density resampling was required.
- Additional implementation checks: 1440 x 900 desktop and 390 x 844 compact mobile.
- The source includes its FAOS sidebar at 924 px while the existing Hermes shell intentionally switches to its mobile header below 1024 px. Mission Control preserves that host breakpoint rather than recreating or overriding the shell.

## State

- Dark: Hermes Teal global theme, all execution lanes, FAOSX board, live host bridge.
- Light: Nous Blue global theme, same board and telemetry state.
- Focused desktop: Codex selected with health, capability envelope, risk state, and supported actions visible.
- Compact: 390 px mobile fallback with four KPI cards, scroll-safe filters, and collision-free agent positions.

## Required fidelity surfaces

- Fonts and typography: bundled Inter and JetBrains Mono match the reference's restrained sans/technical-mono hierarchy; compact labels remain legible without wrapping after the second pass.
- Spacing and layout rhythm: sparse orbital composition, thin borders, compact segmented controls, and low-density panels follow the reference. Added KPIs and inspector are intentional product requirements and remain subordinate to the orbit.
- Colors and tokens: dark charcoal and light near-white states inherit the dashboard theme; green, amber, and red remain semantic status colors. No decorative gradients were introduced.
- Image quality and asset fidelity: the generated orbital field is a full-resolution raster asset with subtle concentric arcs and speckle texture; it replaces no source logo or icon and remains crisp in both themes.
- Copy and content: operator copy stands alone, states telemetry confidence explicitly, and keeps host approval boundaries visible. Raw prompts, credentials, and environment values are absent.
- Accessibility: native buttons/selects, accessible labels, keyboard focus, Escape-to-close dialogs, reduced-motion, reduced-transparency, and mobile tap targets were verified.

## Focused region evidence

The 1440 x 900 desktop inspector capture was required because the 924 x 540 full-view comparison cannot make the inspector's small telemetry labels and capability chips readable. The focused capture confirms the selected-node treatment, direct health confidence, model fallback copy, risk state, and action envelope without clipping or overlap.

## Comparison history

### Pass 1 — blocked

- [P2] At 924 x 540, the KPI strip collapsed to two columns and pushed the orbital map almost entirely below the fold.
- [P2] Risk and live controls wrapped inside the compact filter panel.
- Fixes: kept KPIs in a compact four-column row, reduced compact typography/padding, hid nonessential compact detail text, prevented control wrapping, and shortened the compact live pill.
- Post-fix evidence: `/private/tmp/mission-control-dark-924x540-final.png` and `/private/tmp/mission-control-light-924x540-final-v2.png`.

### Pass 2 — blocked

- [P2] Qwen and Grok labels collided in the 390 px orbital fallback.
- Fix: added deterministic compact orbit positions for CLI workers, providers, and ACP clients.
- Post-fix evidence: `/private/tmp/mission-control-mobile-390x844-final.png`.

### Pass 3 — passed

- No actionable P0, P1, or P2 differences remain.
- Remaining composition differences are intentional: Mission Control keeps the Hermes navigation shell and adds the requested KPI/inspector control surfaces instead of reproducing the FAOS customer-portal chrome.

## Primary interactions tested

- Open Mission Control from the existing Hermes plugin navigation.
- Select an agent and inspect live normalized telemetry.
- Open the Gemini dispatch dialog and verify scratch-only workspace, plan/auto-edit modes, and constraint guidance.
- Close the dialog with Escape.
- Toggle the risk filter and verify pressed state.
- Switch the global dark/light theme and restore Hermes Teal.
- Verify live polling/stream status, 924 px compact desktop, 1440 px desktop inspector, and 390 px mobile.
- Browser console errors checked after desktop, light, and mobile states: none.

## Follow-up polish

- P3: a future Hermes shell breakpoint below 1024 px could preserve a slim sidebar at reference-sized desktop captures, but Mission Control should not override that global navigation decision locally.
