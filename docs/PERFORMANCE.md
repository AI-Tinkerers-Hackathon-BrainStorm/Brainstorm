# Performance

## Budgets implemented

- Local preview: browser-native `video.srcObject`, requested at 720p and about 24 FPS.
- AI input: 640×360 JPEG around quality 0.7, normally about 1 FPS and never above 2 FPS.
- Realtime WebRTC video: a separate canvas stream capped at 1 FPS; the preview stream is not forwarded at display FPS. RTP media is gated until the realtime session acknowledges its configuration.
- OCR/manual scan: one high-resolution JPEG only when requested.
- Specialist concurrency: one active frame plus one replaceable pending frame.
- Working memory: 20 observations / 20 seconds.
- Transcript: 30 entries; rendered view: 10 entries.
- Timeline: 100 entries; drawer view: latest 12.
- Background vision has an 8-second provider budget and stale results older than 5 seconds are diagnostic-only. Detailed scans return a Flash result with a 13-second provider budget, then reuse the same transient frame for a sequential Max refinement with a 32-second provider budget. Max refinement never blocks or interrupts the first answer. OCR uses 13 seconds.

## Backpressure

`LatestFrameProcessor` implements “latest frame wins.” While frame A is encoding or awaiting the API, newly arriving frames replace the single pending frame. Replaced `ImageBitmap` objects are closed immediately. No FIFO AI queue exists. A new user turn aborts an older Max refinement before starting another specialist request.

Returned background observations retain `capturedAt`, `requestSentAt`, and `receivedAt`. A stale response never enters current working memory, navigation-style guidance, or temporal approaching inference.

## Off-main-thread work

`frame.worker.ts` uses `OffscreenCanvas` to resize and JPEG-encode sampled frames. The live video element remains outside React state. High-resolution manual scans use a short-lived canvas because they are user-triggered single captures.

## Adaptive quality

`AdaptiveQualityController` exposes HIGH (720p / 1 FPS), BALANCED (540p / 0.7 FPS), and SAFE (360p / 0.4 FPS). Two high-latency, failed, or slow-encode samples degrade one tier; six healthy samples recover one tier. Low bandwidth mode forces SAFE and pauses automatic analysis.

## Cleanup

Camera tracks, speech recognition, the WebRTC peer, remote audio, canvas sampling timer, worker, pending bitmap, request abort controller, and subscriptions are closed on teardown.
