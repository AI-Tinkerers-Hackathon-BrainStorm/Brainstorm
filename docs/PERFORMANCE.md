# Performance

## Budgets implemented

- Local preview: browser-native `video.srcObject`, requested at 720p and about 24 FPS.
- AI input: up to 960×540 JPEG around quality 0.72, normally about 1 FPS and never above 2 FPS. This keeps enough color and edge detail for cups, cards, keys, medicine bottles, and similar small objects without sending high-resolution video continuously.
- Realtime WebRTC video: a separate canvas stream capped at 1 FPS; the preview stream is not forwarded at display FPS. RTP media is gated until the realtime session acknowledges its configuration.
- OCR/manual scan: one high-resolution JPEG only when requested.
- Local ASR: latest-wins 3-second microphone clips are downsampled to 16 kHz PCM and sent only to the same-origin Vercel function. The quantized multilingual `whisper.cpp` base runtime runs on CPU; raw clips are deleted from `/tmp` after each request.
- Specialist concurrency: one active frame plus one replaceable pending frame.
- Working memory: 20 observations / 20 seconds.
- Recent object memory: five-minute TTL, 500 merged identities, confidence threshold 0.45.
- Supabase writes: duplicate identities coalesce in the browser and database; flush every five seconds, at 20 pending identities, or immediately for an episodic event. Both RPCs cap batches at 50, apply 5–60 second exponential retry backoff, and enforce 500 recent identities / 100 events per user.
- Transcript: 30 entries; rendered view: 10 entries.
- Timeline: 100 entries; drawer view: latest 12.
- Background vision has a 12-second provider budget to cover measured API variance, while anything older than 7 seconds is excluded from current-view guidance and temporal reasoning. A late successful background result can update bounded `LAST_SEEN` memory only, using its original capture timestamp; results older than 15 seconds are dropped entirely. Detailed scans return a Flash result with a 13-second provider budget; a weak result can use one sequential Max attempt with a 32-second budget. A useful Flash result is spoken first and the same transient frame may then be refined by Max in the background. A new user turn or scan aborts refinement without waiting. OCR uses 13 seconds.
- A user turn blocks only proactive background announcements, and that block expires after 10 seconds if the model never finishes. After ASR, a 2.5-second watchdog answers from current evidence or forces the direct text fallback if realtime stays silent. Background sampling pauses during the user turn and resumes afterward.

## Backpressure

`LatestFrameProcessor` implements “latest frame wins.” While frame A is encoding or awaiting the API, newly arriving frames replace the single pending frame. Replaced `ImageBitmap` objects are closed immediately. No FIFO AI queue exists. A new user turn aborts an older Max refinement without waiting for it, then starts another specialist request if needed.

Returned background observations retain `capturedAt`, `requestSentAt`, and `receivedAt`. A stale response never enters current working memory, navigation-style guidance, or temporal approaching inference.

## Off-main-thread work

`frame.worker.ts` uses `OffscreenCanvas` to resize and JPEG-encode sampled frames. The live video element remains outside React state. High-resolution manual scans use a short-lived canvas because they are user-triggered single captures.

## Adaptive quality

`AdaptiveQualityController` exposes HIGH (720p / 1 FPS), BALANCED (540p / 0.7 FPS), and SAFE (360p / 0.4 FPS). Two high-latency, failed, or slow-encode samples degrade one tier; six healthy samples recover one tier. Low bandwidth mode forces SAFE and pauses automatic analysis.

## Cleanup

Camera tracks, speech recognition, the WebRTC peer, remote audio, canvas sampling timer, worker, pending bitmap, request abort controller, and subscriptions are closed on teardown.
