# Performance

## Budgets implemented

- Local preview: browser-native `video.srcObject`, requested at 720p and about 24 FPS.
- AI input: up to 960×540 JPEG around quality 0.72, normally about 1 FPS and never above 2 FPS. This keeps enough color and edge detail for cups, cards, keys, medicine bottles, and similar small objects without sending high-resolution video continuously.
- Realtime WebRTC video: a separate canvas stream capped at 1 FPS; the preview stream is not forwarded at display FPS. Following the provider's WebRTC sequence, RTP media is restored on `session.created`; connected status still requires `session.updated` and completed track restoration.
- OCR/manual scan: one high-resolution JPEG only when requested.
- Specialist concurrency: one active frame plus one replaceable pending frame.
- Working memory: 20 observations / 20 seconds.
- Transcript: 30 entries; rendered view: 10 entries.
- Timeline: 100 entries; drawer view: latest 12.
- Background vision has a 12-second provider budget to cover measured API variance, while anything older than 7 seconds is excluded from current-view guidance and temporal reasoning. A late successful background result can update bounded `LAST_SEEN` memory only, using its original capture timestamp; results older than 15 seconds are dropped entirely. Compact Flash scans have a 20-second provider / 23-second client budget to accommodate measured 10–12-second API responses plus upload time. Background and first-answer prompts bound their object count and output size while retaining enough token headroom for valid structured JSON. A successful Flash result is spoken first, including a sparse inventory; the same transient frame may then be refined by Max with a 32-second budget. Timeout or network failures do not trigger Max. Delayed scan speech names the capture age rather than implying current visibility. A new user turn or scan aborts refinement without waiting. OCR uses 13 seconds.
- A user turn blocks only proactive background announcements, and that block expires after 10 seconds if the model never finishes. After ASR, a 2.5-second watchdog answers from current evidence or forces the direct text fallback if realtime stays silent. Background sampling pauses during the user turn and resumes afterward.

## Backpressure

`LatestFrameProcessor` implements “latest frame wins.” While frame A is encoding or awaiting the API, newly arriving frames replace the single pending frame. Replaced `ImageBitmap` objects are closed immediately. No FIFO AI queue exists. A new user turn aborts an older Max refinement without waiting for it, then starts another specialist request if needed.

Automatic HTTPS sampling remains stopped for the complete foreground scan and Max refinement. It restarts only after both request owners clear. Cancellation is forwarded to the vision server request where the hosting runtime supports client disconnect signals. Client timeouts are reported as failures; user supersession is reported as cancellation.

Returned background observations retain `capturedAt`, `requestSentAt`, and `receivedAt`. A stale response never enters current working memory, navigation-style guidance, or temporal approaching inference.

## Off-main-thread work

`frame.worker.ts` uses `OffscreenCanvas` to resize and JPEG-encode sampled frames. The live video element remains outside React state. High-resolution manual scans use a short-lived canvas because they are user-triggered single captures.

## Adaptive quality

`AdaptiveQualityController` exposes HIGH (720p / 1 FPS), BALANCED (540p / 0.7 FPS), and SAFE (360p / 0.4 FPS). Two high-latency, failed, or slow-encode samples degrade one tier; six healthy samples recover one tier. Low bandwidth mode forces SAFE and pauses automatic analysis.

## Cleanup

Camera tracks, speech recognition, the WebRTC peer, remote audio, canvas sampling timer, worker, pending bitmap, request abort controller, and subscriptions are closed on teardown.
