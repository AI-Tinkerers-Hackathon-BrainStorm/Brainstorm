# Safety and privacy

SightLoop is experimental assistance, not a certified navigation or collision-avoidance device.

## Hard limits

- Never tell a user that it is safe to cross a street.
- Never replace a cane, guide dog, mobility training, or the user’s judgment.
- Never guarantee that a route is obstacle-free.
- Never invent precise distance, speed, coordinates, or time to collision.
- Treat approaching-object output as a relative image pattern only, after at least three supporting observations.
- The hackathon stable path keeps approaching patterns in the debug timeline and does not proactively speak them.
- Do not infer that someone removed an object from one missing frame. A camera pan produces `NOT_IN_CURRENT_VIEW`.
- Use “may have” for conservative multi-frame inferences; never accuse a person of theft. After several fresh, still frames without a previously seen object, say it may have been moved, covered, or picked up, and that the cause is unconfirmed. A late background result may update only timestamped last-seen memory, never current-view guidance or an absence inference.

## Data handling

Raw camera video is neither recorded nor persisted. Sampled frames go directly to DashScope for inference and are not written to application storage. The in-browser working-memory ring is bounded and disappears with the page. Optional persistent memory contains only structured events such as an item, relation, timestamp, confidence, and evidence IDs. Bounded Flash scans and Max scene refinements may also be cached on-device as structured `LAST_SEEN` summaries; they are never promoted to current visibility after their frame becomes stale. A delayed manual answer can describe its captured frame using the capture age and an explicit statement that present visibility is unconfirmed.

Long-lived keys stay in Vercel/server environment variables. Logs contain only frame IDs, model names, timestamps, latency, status, and error categories.

## User-facing behavior

The persistent footer states the limitation without interrupting the demo. Permission and network failures preserve camera preview and offer manual scan. Speech remains concise to reduce auditory overload; ordinary unrelated changes are silent.
