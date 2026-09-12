# Agent design

SightLoop uses one proactive orchestrator. Specialist calls are tools, not peer agents.

## Loop

1. `set_goal` converts a spoken or typed command to a structured goal.
2. `FrameSampler` observes at a mode- and quality-dependent rate.
3. Qwen returns a normalized `VisionObservation` with timestamps, objects, stable appearance cues, optional real boxes, text, a goal assessment, and directly observed placement events.
4. The tracker, bounded working memory, temporal reasoner, and salience policy update. Fresh objects above confidence are stored as structured `LAST_SEEN` events; three still frames without a previously seen object may add a conservative `INFERRED` absence, never a theft claim.
5. The orchestrator can answer immediately from current vision plus memory. It then decides whether to stay silent, guide, verify, remember, or announce.
6. Find mode requires two consecutive supporting observations unless fast mode is explicit.
7. A later frame verifies or revises the belief.

## Placement memory and re-identification

Every fresh recognizable object at confidence 0.45 or above enters a five-minute rolling memory. Repeated sightings with the same normalized label, color, and appearance update one identity with its latest relation, time, confidence, count, and bounded evidence IDs.

A high-confidence `PUT_DOWN` event is saved only when the subject and stable anchor are both visible. Its persistent record contains capture time, subject, relation, anchor, full location, discriminating appearance, confidence, and evidence IDs. Raw frames are never persisted.

“Where did I put …?” prefers the last placement, falls back to the recent-object window, answers with uncertainty, and starts a continuing find goal. Four misses spanning at least five seconds may produce “may have been moved, or may be outside the camera view”; absence never proves removal. A candidate re-identification still needs two supporting observations and is announced as “may be yours.”

## Modes and tools

Modes: `IDLE`, `EXPLORE`, `FIND`, `READ`, `REMEMBER`, `REVIEW`.

The `ToolDispatcher` exposes and logs `set_goal`, `clear_goal`, `remember_event`, `recall_memory`, and `announce`. The UI also routes deep vision, OCR, and vibration through explicit adapters. The Agent View caps its timeline at 100 entries.

## Speech

Qwen3.5 Omni Realtime is connected over browser WebRTC when signaling succeeds. The browser sends microphone audio and a one-FPS canvas video track; remote model audio returns over RTP. Browser speech recognition and speech synthesis are the automatic fallback. The deterministic visual loop continues over sampled HTTPS calls so structured localization, verification, memory, and degraded mode remain reliable.

## Epistemics

- `CURRENTLY_VISIBLE`: confirmed in the current normalized observation.
- `LAST_SEEN`: historical structured evidence; always paired with “I can’t confirm it’s still there.”
- `INFERRED`: conservative multi-frame inference.
- `UNKNOWN`: no adequate evidence.

The realtime conversation, structured vision, OCR, and direct text fallback prompts have separate contracts in `src/agent/prompts.ts`.
