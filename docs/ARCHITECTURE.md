# Architecture decision

SightLoop is a mobile-first Next.js application deployed on Vercel. The browser owns the smooth camera preview, microphone capture, lightweight frame sampling, and haptics. It never puts camera frames into React state.

The UI talks only to normalized TypeScript provider interfaces. Server route handlers hold the long-lived DashScope key and call Qwen. WebRTC is reported as connected only after ICE/peer connectivity, an open DataChannel, a confirmed `session.updated`, and a live sampled video track; otherwise text uses an explicit server fallback and browser speech. Deep vision and OCR remain single-concurrency specialist calls.

Qwen Omni Realtime supplies the low-latency camera and synthesized-audio path. Microphone input is captured as bounded 16 kHz PCM clips and transcribed by a Vercel-hosted quantized multilingual `whisper.cpp` runtime; Qwen never receives microphone RTP or runs ASR. Background HTTPS observations use the lightweight vision model. An explicit detailed scene question captures one high-resolution still, returns a `deepVision` Flash result first, then runs `deepVisionMax` sequentially as a non-speaking refinement. Max results are stored only as bounded structured last-seen scenes; explicit reading alone uses OCR.

The agent is one deterministic orchestrator around one primary model: goal → observe → decide → act → verify. Working visual memory remains a bounded 20-second ring. A separate five-minute, max-500 structured object memory merges repeated identities, while important placement and last-seen events remain bounded at 100 with 30-day demo retention. Those structured memories use local storage as an offline cache and sync through bounded Supabase RPCs under an RLS-protected anonymous `auth.uid()`; authenticated clients have no direct table write permission. Late background results never become current observations or guidance, but a bounded result can still update historical `LAST_SEEN` memory with its original capture time. A first spoken answer may come from the latest observation or memory while a specialist scan continues. Detailed Max scene summaries remain on-device. Every frame carries capture, send, and receive timestamps. A latest-frame-wins channel prevents an AI frame queue. A user turn that never receives a model response expires so background decisions resume.

## Modules

- `src/media`: camera, microphone, frame sampler, worker, and cleanup.
- `src/providers`: normalized realtime, deep-vision, and OCR boundaries.
- `src/agent`: state machine, salience, tool dispatch, and system prompt.
- `src/memory` and `src/temporal`: bounded observations, epistemic memory, tracking, and conservative events.
- `src/lib/supabase` and `supabase/migrations`: browser Auth/Data API setup, RLS schema, and database-side recent-object merging.
- `src/performance`: adaptive quality and measurements.
- `app/api`: Vercel route handlers that keep provider secrets server-side.

This architecture favors a stable hackathon loop over multi-agent orchestration, local models, or heavyweight tracking.
