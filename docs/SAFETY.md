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

Raw camera video is neither recorded nor persisted. Sampled frames go directly to DashScope for inference and are not written to application storage. The in-browser working-memory ring is bounded and disappears with the page. Supabase receives only bounded structured object sightings and important events: labels, appearance cues, relations, anchors, timestamps, confidence, and non-image evidence IDs. It never receives frames, video, image data URLs, full provider payloads, or OCR transcripts. Bounded Max scene refinements remain cached on-device as structured `LAST_SEEN` summaries and are never promoted to current visibility after their frame becomes stale.

Long-lived model keys stay in Vercel/server environment variables. The browser receives only Supabase's publishable key. Supabase Anonymous Auth provides a real `auth.uid()`; both memory tables enforce owner-scoped RLS and expose direct reads only, while bounded security-definer RPCs derive the owner from the JWT. No service-role key is shipped. The store pins the session UID and refuses writes if it changes. Public deployments must enable CAPTCHA and Auth rate limits. Logs contain only frame IDs, model names, timestamps, latency, status, and error categories.

## User-facing behavior

The persistent footer states the limitation without interrupting the demo. Permission and network failures preserve camera preview and offer manual scan. Speech remains concise to reduce auditory overload; ordinary unrelated changes are silent.
