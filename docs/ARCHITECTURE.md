# Architecture decision

SightLoop is a mobile-first Next.js application deployed on Vercel. The browser owns the smooth camera preview, microphone capture, lightweight frame sampling, and haptics. It never puts camera frames into React state.

The UI talks only to normalized TypeScript provider interfaces. Server route handlers hold the long-lived DashScope key and call Qwen. WebRTC is reported as connected only after ICE/peer connectivity, an open DataChannel, a confirmed `session.updated`, and a live sampled video track; otherwise text uses an explicit server fallback and browser speech. Deep vision and OCR remain single-concurrency specialist calls.

Qwen Omni Realtime is the low-latency camera and microphone path. Background HTTPS observations use the lightweight vision model. An explicit scene question captures one high-resolution still, returns a compact `deepVision` Flash result first, then runs `deepVisionMax` sequentially as a non-speaking refinement. A sparse Flash inventory still answers immediately. Only malformed structured output can trigger one sequential Max fallback; timeouts, access failures, and overload never cascade to a slower model. Both results are cached as bounded structured last-seen scenes; explicit reading alone uses OCR. A delayed manual result answers about the captured frame with its age, without claiming the objects are still visible.

The agent is one deterministic orchestrator around one primary model: goal → observe → decide → act → verify. Working visual memory is a bounded in-memory ring; structured last-seen events persist locally and can answer later where-is questions. Late background results never become current observations or guidance, but a bounded result can still update historical `LAST_SEEN` memory with its original capture time. A first spoken answer may come from the latest observation or memory while a specialist scan continues. Every frame carries capture, send, and receive timestamps. A latest-frame-wins channel prevents an AI frame queue. A user turn that never receives a model response expires so background decisions resume.

## Modules

Ordinary scene questions use the last two minutes of bounded structured observations as input to Qwen text reasoning, including late background observations. This avoids uploading another image for every question. Capture times and historical status accompany the evidence; an explicit detailed scan still captures a new frame. No raw debug instructions or image data are supplied to timeline reasoning.

- `src/media`: camera, microphone, frame sampler, worker, and cleanup.
- `src/providers`: normalized realtime, deep-vision, and OCR boundaries.
- `src/agent`: state machine, salience, tool dispatch, and system prompt.
- `src/memory` and `src/temporal`: bounded observations, epistemic memory, tracking, and conservative events.
- `src/performance`: adaptive quality and measurements.
- `app/api`: Vercel route handlers that keep provider secrets server-side.

This architecture favors a stable hackathon loop over multi-agent orchestration, local models, or heavyweight tracking.
