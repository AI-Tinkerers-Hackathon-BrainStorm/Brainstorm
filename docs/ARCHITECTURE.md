# Architecture decision

SightLoop is a mobile-first Next.js application deployed on Vercel. The browser owns the smooth camera preview, microphone capture, lightweight frame sampling, and haptics. It never puts camera frames into React state.

The UI talks only to normalized TypeScript provider interfaces. Server route handlers hold the long-lived DashScope key and call Qwen. WebRTC is reported as connected only after ICE/peer connectivity, an open DataChannel, a confirmed `session.updated`, and a live sampled video track; otherwise text uses an explicit server fallback and browser speech. Deep vision and OCR remain single-concurrency specialist calls.

Qwen Omni Realtime is the low-latency camera and microphone path. Background HTTPS observations use the lightweight vision model. An explicit detailed scene question captures one high-resolution still, returns a `deepVision` Flash result first, then runs `deepVisionMax` sequentially as a non-speaking refinement. Max results are stored only as bounded structured last-seen scenes; explicit reading alone uses OCR.

The agent is one deterministic orchestrator around one primary model: goal → observe → decide → act → verify. Working visual memory is a bounded in-memory ring; only structured episodic events may persist locally. Every frame carries capture, send, and receive timestamps. A latest-frame-wins channel prevents an AI frame queue.

## Modules

- `src/media`: camera, microphone, frame sampler, worker, and cleanup.
- `src/providers`: normalized realtime, deep-vision, and OCR boundaries.
- `src/agent`: state machine, salience, tool dispatch, and system prompt.
- `src/memory` and `src/temporal`: bounded observations, epistemic memory, tracking, and conservative events.
- `src/performance`: adaptive quality and measurements.
- `app/api`: Vercel route handlers that keep provider secrets server-side.

This architecture favors a stable hackathon loop over multi-agent orchestration, local models, or heavyweight tracking.
