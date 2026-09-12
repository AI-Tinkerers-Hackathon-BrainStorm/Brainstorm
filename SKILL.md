---
name: sightloop
description: Build or maintain the SightLoop visual assistance web app when work touches its camera pipeline, Qwen providers, agent loop, memory, temporal reasoning, accessibility, safety, or deployment.
---

# SightLoop development

Read `AGENTS.md` and the documentation it routes to before editing the relevant subsystem.

Keep one orchestrator around normalized provider data. Preserve the provider boundary: UI and agent code must not consume DashScope response shapes. Put model identifiers only in `src/config/models.ts` and secrets only in server route handlers.

When changing the observation loop, verify smooth local preview, AI sampling at no more than 2 FPS, latest-frame-wins backpressure, one specialist request at a time, timestamp propagation, cleanup, and manual-scan fallback.

When changing reasoning, add or update tests for current visibility versus last seen, camera pan versus removal, two-observation find verification, and three-observation approach detection. Calibrate every spoken claim to its evidence. Safety-critical guidance remains conservative and must never imply certified navigation.

When changing UI, test a narrow mobile viewport first, preserve large targets and screen-reader labels, keep transcript and visible state aligned with speech, and show bounding boxes only from normalized provider coordinates.

Finish with lint, typecheck, tests, and a production build. Do not log keys, raw audio, image data URLs, or full provider payloads.
