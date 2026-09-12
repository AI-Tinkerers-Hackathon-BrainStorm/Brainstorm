# SightLoop agent guide

SightLoop is a mobile-first visual assistance agent. Preserve the complete loop: user goal → sampled observation → normalized understanding → deterministic decision → concise voice/haptic action → later observation → verification.

## Read first

- Read `docs/ARCHITECTURE.md` before changing boundaries.
- Read `docs/SAFETY.md` before changing prompts, guidance, temporal claims, or memory language.
- Read `docs/PERFORMANCE.md` before changing camera, sampling, queues, or request concurrency.
- Follow `SKILL.md` for repository-specific development work.

## Non-negotiable invariants

- Never expose `DASHSCOPE_API_KEY` to client code or logs.
- Never store raw video. Structured episodic memory may be stored on-device.
- The `<video>` receives `MediaStream` through `srcObject`; frames never enter React state.
- Display FPS and AI sampling FPS stay independent. AI input is normally at or below 2 FPS.
- Latest frame wins. There is at most one active specialist request and one replaceable pending frame.
- Draw a box only when a provider returned a valid box.
- “Last seen” is not “currently visible.” Camera movement is not evidence that an object was removed.
- Never claim a crossing is safe, guarantee no obstacle, or invent distance/collision time.

## Change map

- Browser media: `src/media/`
- Agent decisions and prompt: `src/agent/`
- Provider normalization: `src/providers/`
- Memory and temporal evidence: `src/memory/`, `src/temporal/`
- Server-held model calls: `app/api/`
- User experience: `src/components/SightLoopApp.tsx`
- Central model IDs: `src/config/models.ts`

Before handing off, run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. Add focused tests for every changed epistemic, temporal, state, or backpressure rule.
