# SightLoop

SightLoop is a proactive visual agent for blind and low-vision people. It keeps a goal, observes the live camera over time, remembers structured events, decides when intervention is useful, acts with concise speech and haptics, and verifies against later observations.

It is deliberately not a “take one photo, describe it” chat interface.

## Why it is an agent

The persistent loop is goal → observe → understand → decide → act → observe again → verify. Find mode continues without a repeated user prompt, uses salience to avoid narrating irrelevant changes, and requires consecutive evidence before announcing success.

## Architecture

- Next.js, React, TypeScript, Tailwind CSS, browser Media/WebRTC APIs, and Vercel route handlers.
- Qwen3.5 Omni Flash Realtime for WebRTC speech/video when available.
- Qwen3.8 Flash for structured sampled-frame vision and Qwen3.5 OCR for explicit reading.
- Deterministic state machine, bounded memory, lightweight object continuity, conservative temporal reasoning, and a logged action layer.
- No local model weights, raw-video storage, or client-side long-lived API key.

See [Architecture](docs/ARCHITECTURE.md), [Agent design](docs/AGENT_DESIGN.md), [Performance](docs/PERFORMANCE.md), and [Safety](docs/SAFETY.md).

## Setup

Requirements: Node.js 22.13 or newer and an Alibaba Cloud Model Studio API key.

1. Copy `.env.example` to `.env.local`.
2. Add `DASHSCOPE_API_KEY`.
3. Run `npm ci`.

See [API setup](docs/API_SETUP.md) for region and model overrides.

## Run locally

```bash
npm run dev
```

Open `http://localhost:3000`. Camera and microphone work on localhost. For another phone on the LAN, use an HTTPS tunnel or a trusted local HTTPS certificate; mobile browsers block camera access on ordinary HTTP origins.

Validation:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Deploy to Vercel

Import the repository into Vercel as a Next.js project. Add `DASHSCOPE_API_KEY` (and, when used, `DASHSCOPE_BASE_URL` and model overrides) to Production, Preview, and Development environments. Deploy without a custom build override; Vercel will run the Next.js build. The HTTPS deployment can request camera, microphone, speaker, vibration, and PWA installation permissions.

## Model routing

- Continuous audio/video conversation: `qwen3.5-omni-flash-realtime` over WebRTC with server-proxied SDP authentication.
- Fast structured observations and the first manual-scan answer: `qwen3.8-flash` through `/api/vision`.
- Non-blocking detailed refinement: `qwen3.8-max`; its structured result is cached as last-seen context and never interrupts the fast answer.
- Explicit READ mode: `qwen3.5-ocr` through `/api/ocr`.
- Browser speech recognition and speech synthesis: automatic fallback when realtime WebRTC is unavailable.

All model names are centralized in `src/config/models.ts`.

## Mobile testing

- Android: use current Chrome, open the HTTPS deployment, allow camera and microphone, keep media volume on, and allow vibration if the browser/OS offers it.
- iPhone: use current Safari, open the HTTPS deployment, allow camera and microphone when prompted, turn off silent mode if speech is inaudible, and use Add to Home Screen for the PWA shell. iOS does not expose `navigator.vibrate`, so haptics silently fall back.
- On both platforms, start with the rear camera, speak a goal, then confirm that the visible transcript matches the audio guidance.

## Demo script

Use the timed script in [docs/DEMO.md](docs/DEMO.md). It covers Find, OCR, last-seen memory, the Agent View timeline, and low-bandwidth failure recovery.

## Known limitations

- Recognition quality depends on lighting, camera focus, network latency, and provider availability.
- WebRTC support and region-specific DashScope workspace configuration may vary; the app degrades to browser speech plus sampled HTTPS vision.
- Browser speech recognition availability differs by browser.
- Bounding boxes are model-produced approximations, not safety-grade localization.
- Structured memory is device-local and has no multi-device sync.
- Approach detection uses relative image growth, not depth sensing.

## Safety

SightLoop is experimental assistance. It is not a sole mobility aid and must not be used to decide whether crossing a street or another safety-critical action is safe. Read [docs/SAFETY.md](docs/SAFETY.md).

## Next priorities

1. Field-test Qwen WebRTC across the chosen Model Studio region and mobile carrier networks.
2. Add signed-in, encrypted opt-in memory sync only if users request it.
3. Add a calibrated motion/scene-change estimator for fewer specialist calls.
4. Add automated browser tests on physical Android and iPhone devices.
