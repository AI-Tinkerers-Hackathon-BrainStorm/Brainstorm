# SightJarvis

**A mobile-first visual assistance agent for blind and low-vision users.**

SightJarvis combines camera sampling, voice interaction, structured scene understanding, and on-device memory to help users understand their surroundings, find objects, read text, and recall where objects were last observed.

The application follows a continuous observation and verification loop:

**User goal → sampled observation → structured understanding → decision → voice or haptic feedback → later observation → verification**

SightJarvis is an experimental prototype intended for controlled demonstrations and evaluation. It is not a certified navigation, collision-avoidance, or medical assistance device.

> **Safety notice**
>
> Do not rely on SightJarvis to determine whether a street crossing, route, or other safety-critical action is safe. Recognition can be incomplete, incorrect, or delayed. SightJarvis does not replace a cane, guide dog, orientation and mobility training, or the user’s judgment.

## 1. Project Scope and Current Status

SightJarvis goes beyond single-image question answering by maintaining user goals and structured evidence across observations.

The current implementation includes:

- **Scene questions:** Answer questions such as “What can you see?” using recent observations.
- **Object finding:** Maintain a FIND goal and verify candidate objects against subsequent observations.
- **Text reading:** Invoke a dedicated OCR path for explicit READ requests.
- **Object memory:** Record object names, colors, spatial relationships, timestamps, and evidence.
- **Location recall:** Answer questions such as “Where are my keys?” while distinguishing current visibility from last-seen information.
- **Detailed scanning:** Analyze a high-resolution still image, return a fast result, and perform Max refinement when appropriate.
- **Voice interaction:** Support Qwen WebRTC and fallback paths using browser speech recognition and speech synthesis.
- **Observability:** Display connection information, request timing, scan outcomes, and an Agent Timeline.

The current version does **not** guarantee:

- Detection of every small object.
- Accurate colors, text, bounding boxes, or spatial relationships in every scene.
- WebRTC availability across all accounts, regions, devices, and networks.
- Complete video-history memory, cross-device memory synchronization, or production-grade account authentication.
- A fixed end-to-end response time.

This document describes the Timeline question-answering fix included in commit `35daa71`. If the default branch does not yet contain that fix, use `feat/timely-reasoning-and-memory`.

**Naming note:** SightJarvis is the current project name. Existing source filenames, package identifiers, browser storage keys, and some interface or spoken strings may still use the previous name, SightLoop. This documentation update does not change those implementation details. The repository remains `AI-Tinkerers-Hackathon-BrainStorm/Brainstorm`.

## 2. Interaction Modes

### Scene Questions

Examples:

```text
What can you see?
Describe the scene.
我前面有什么？
桌子上有什么？
这个是什么？
```

These questions do not automatically replace the active persistent visual goal.

When recent structured evidence is available, the application sends a bounded selection of observations from the last two minutes to Qwen for text reasoning. It does not upload a new image for every question.

Answers should use wording such as “Based on my recent observations.” **Recent observations are not live video.**

When no usable evidence is available, the application attempts a fresh scan or explains that it has not received a reliable observation instead of inventing a scene.

### Persistent Goals and Specialist Operations

Examples:

```text
Find the red cup.
帮我找红色杯子

Read this label.
读一下这个标签

Remember my keys.
记住我的钥匙放哪

Keep watching.
帮我看着
```

FIND mode maintains an object-search goal and uses subsequent observations for verification. A single detection does not guarantee that the target has been found.

READ uses a separate OCR path. General scene analysis does not continuously invoke OCR.

Intent recognition currently uses lightweight English and Chinese rules rather than a comprehensive natural-language understanding system. Complex, ambiguous, or unsupported expressions may be misclassified.

### Memory Questions

Examples:

```text
Where are my keys?
Where did I put the cup?
杯子在哪？
我的钥匙不见了
```

Memory responses distinguish between:

- `CURRENTLY_VISIBLE`: Supported by visual evidence that satisfies the current-view validity rules.
- `LAST_SEEN`: Previously observed, without confirmation that the object remains there.
- `INFERRED`: A conservative inference based on limited evidence.
- `UNKNOWN`: No reliable evidence is available.

For example:

> I last saw the red cup on the table. I can’t confirm it is still there.

Only when conditions such as multiple supporting frames and low camera motion are satisfied may the application suggest that an object “may have been moved or occluded.”

An object’s absence does not prove that someone picked it up, and it must not be used to infer theft.

## 3. Architecture and Data Flow

SightJarvis uses a deterministic Agent Orchestrator to manage state, memory, and actions around normalized visual data. It does not depend on a complex multi-agent architecture.

### Browser Responsibilities

The browser handles:

- Camera and microphone permissions.
- Smooth local video preview.
- Low-frequency frame sampling and encoding.
- WebRTC media connections.
- Browser speech recognition, speech synthesis, and haptics where supported.
- User goals, working memory, and structured on-device memory.
- Diagnostic state and Timeline rendering.

The preview receives its `MediaStream` through `video.srcObject`. Raw frames do not enter React state, and display frame rate remains separate from AI sampling frequency.

### Server Responsibilities

Next.js Route Handlers handle:

- Keeping the DashScope API key server-side.
- Proxying WebRTC signaling.
- Calling Qwen text, vision, and OCR models.
- Validating inputs, enforcing request budgets, and normalizing model output.

The client does not receive the long-lived API key.

### Main Processing Paths

**Ordinary scene questions**

Recent structured observations → timestamped historical evidence → Qwen text reasoning → concise answer.

**Automatic scene observation**

Low-frequency sampled frame → Flash structured vision → freshness validation → current observation or historical memory.

**Detailed scanning**

High-resolution still image → Flash analysis → initial answer → sequential Max refinement → structured historical cache.

Max refinement does not automatically interrupt the initial answer. A new request can cancel an older refinement.

**Explicit text reading**

High-resolution still image → OCR → normalized text → reading feedback.

**Native realtime interaction**

Sampled video and microphone → Qwen Omni WebRTC → native conversation and audio.

WebRTC availability is separate from the availability of HTTPS text and vision endpoints.

## 4. Model Routing

Model configuration is centralized in [`src/config/models.ts`](src/config/models.ts).

The identifiers below are the defaults configured in the current code. They do not imply that every account or region has access to these models.

### Native Realtime Audio and Video

```text
qwen3.5-omni-flash-realtime
```

Used for Qwen WebRTC sessions. This path requires a compatible workspace endpoint, model permissions, and a functioning browser media connection.

### Text and Timeline Reasoning

```text
qwen3.8-flash
```

Called through `/api/realtime/text`.

Timeline reasoning uses structured observations. It does not upload a fresh image or treat diagnostic logs as model instructions.

### Automatic Vision and Fast Scans

```text
qwen3.8-flash
```

Called through `/api/vision` to produce compact, usable structured observations.

### Detailed Scene Refinement

```text
qwen3.8-max
```

Used to refine detailed scans. Results are cached as timestamped `LAST_SEEN` scene summaries.

Ordinary questions do not unconditionally wait for Max. Timeouts, network failures, permission errors, and rate limits in a fast scan do not automatically trigger a cascade to a slower model.

### OCR

```text
qwen3.5-ocr
```

Called through `/api/ocr` for explicit text-reading requests.

The project does not currently depend on OpenRouter. Actual model availability must be established using the configured account’s permissions and API responses.

## 5. Timeline, Memory, and Evidence Boundaries

### Timeline Reasoning

For ordinary scene questions, the current implementation selects at most:

- Six structured scene records captured within the last two minutes.
- Ten memory events within the same time window.

The input includes capture timestamps, observation ages, scene summaries, object information, and historical status. Input length is bounded.

Repeated observations can support the statement that similar content was observed recently. They do not establish that an object is currently visible.

If model reasoning fails, the application can read a summary of available historical evidence instead of repeatedly asking the user to restart the camera.

### Working Memory

Working memory retains a limited number of observations within a limited time window for current state and temporal reasoning.

It is not a complete video history and does not grow indefinitely.

### Persistent On-Device Memory

Structured object events and a bounded collection of detailed scene summaries are stored in browser `localStorage`.

Stored information may include:

- Object names, colors, and aliases.
- Spatial relationships.
- Capture timestamps and confidence.
- Evidence identifiers.
- Last-seen or inferred status.

Memory is capacity-limited. Clearing site data or switching browsers, devices, or site origins may make previous memory unavailable.

**Different Vercel Preview domains and the Production domain do not share browser local storage.**

The current implementation does not provide cross-device synchronization, cloud memory backups, or application-level memory encryption.

### Stale Observations

Background observations that exceed the current-view validity window are not used for current directional guidance or approaching-object inference.

Within an allowed historical age limit, a delayed result can still be stored as `LAST_SEEN`. Therefore:

```text
Late observation stored as last-seen only
```

does not necessarily indicate a recognition failure. It indicates that the result may be useful historically but is too old to represent the current view.

Older background results are discarded.

## 6. Performance and Request Control

### Preview and Sampling Are Independent

The browser’s media pipeline handles local preview. AI input is typically sampled at approximately 1 FPS, adapts to performance conditions, and does not exceed 2 FPS.

Sampling frequency is not the same as completed model responses per second. Actual response frequency depends on encoding, networking, model latency, and request control.

High-resolution images are captured for operations such as manual scanning and reading. The application does not continuously upload high-resolution images every second.

### Latest Frame Wins

Background processing follows a latest-frame-wins policy:

- One active task.
- One replaceable pending frame.
- New frames replace the pending frame rather than joining an expanding FIFO queue.

Automatic HTTPS vision sampling pauses during foreground scanning and refinement to reduce competing work.

Cancellation is forwarded to the request layer where possible. It does not guarantee that an upstream computation or its billing stops immediately.

### Current Request Budgets

The current server-side model request budgets are:

- Timeline and text reasoning: 9 seconds.
- Background vision: 12 seconds.
- Flash detailed scan: 20 seconds.
- Max refinement: 32 seconds.
- OCR: 13 seconds.

These are request budgets, not average latency measurements or response-time guarantees. Uploads, downloads, browser scheduling, and speech playback add further overhead.

Background results older than approximately 7 seconds are excluded from current-view decisions. Results older than 15 seconds are excluded from delayed background memory.

Detailed scans use a separate policy: a delayed answer may describe the captured image, but it must not imply that the image still represents the current scene.

### Low-Bandwidth Mode

Low-bandwidth mode pauses automatic frame analysis and lowers the sampling quality tier.

It does not make the entire application operate offline.

## 7. Local Setup

### Requirements

- Node.js **22.13.0 or newer**.
- npm.
- A valid DashScope API key.
- Access to the required workspace, region, and models.
- A browser capable of accessing the camera and microphone.

The main application stack uses Next.js 16, React 19, TypeScript, and Tailwind CSS. Refer to [`package.json`](package.json) and [`package-lock.json`](package-lock.json) for dependencies and resolved versions.

### Clone the Repository

```bash
git clone https://github.com/AI-Tinkerers-Hackathon-BrainStorm/Brainstorm.git
cd Brainstorm
```

If the default branch does not yet include the Timeline fix described here:

```bash
git switch feat/timely-reasoning-and-memory
```

Install dependencies:

```bash
npm ci
```

### Configure Environment Variables

Copy `.env.example` to `.env.local`.

macOS or Linux:

```bash
cp .env.example .env.local
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env.local
```

Configure:

```dotenv
# Required: server-side only
DASHSCOPE_API_KEY=your_dashscope_api_key

# Required for the current WebRTC implementation.
# This is a Beijing-region example. Replace it with your actual workspace endpoint.
DASHSCOPE_BASE_URL=https://YOUR_WORKSPACE_ID.cn-beijing.maas.aliyuncs.com/compatible-mode/v1

# Optional model overrides
QWEN_REALTIME_MODEL=qwen3.5-omni-flash-realtime
QWEN_TEXT_MODEL=qwen3.8-flash
QWEN_VISION_MODEL=qwen3.8-flash
QWEN_DEEP_VISION_MODEL=qwen3.8-max
QWEN_OCR_MODEL=qwen3.5-ocr
```

Important:

- Never prefix the API key variable with `NEXT_PUBLIC_`.
- Never commit `.env.local` or real credentials.
- The API key, workspace, region, and endpoint must match.
- Do not switch a Beijing key to another regional endpoint simply because the device is located in Hong Kong or Singapore.
- Replace the `YOUR_WORKSPACE_ID` placeholder.
- If using system environment variables, ensure the process starting the application can read them.
- Restart the local server after changing environment variables.

When `DASHSCOPE_BASE_URL` is omitted, the code defaults to:

```text
https://dashscope.aliyuncs.com/compatible-mode/v1
```

The application can attempt text and vision requests through this default endpoint, but the current WebRTC configuration check will select `FALLBACK`.

This does not guarantee that text or vision requests will succeed.

### Development Mode

```bash
npm run dev
```

Open:

[http://localhost:3000](http://localhost:3000)

### Local Production Mode

```bash
npm run build
npm run start
```

Stop the previous server before switching modes on the same port.

### Accessing the Local Server from a Phone

The computer’s `localhost` is not the phone’s `localhost`.

Binding the server to a LAN address alone does not ensure that a mobile browser can access the camera and microphone. Use a trusted HTTPS origin for phone testing, such as a Vercel Preview, a trusted local certificate, or a controlled HTTPS tunnel.

Do not expose unprotected, billable model endpoints through a public tunnel.

## 8. Deploying to Vercel

1. Push the desired code branch to GitHub.
2. Import the repository into Vercel using the Next.js project configuration.
3. Configure server-side environment variables separately for Preview and Production as needed.
4. Verify `DASHSCOPE_API_KEY`, `DASHSCOPE_BASE_URL`, and any model overrides.
5. Create a deployment and inspect its build result and source commit.
6. Test the HTTPS Preview on physical devices.
7. Merge or promote to Production only after device validation.

Changing environment variables does not update an already completed deployment. Redeploy before testing the new configuration.

### Preview Access Protection

If Vercel Deployment Protection is enabled, accessing a Preview or its API may require authentication. Unauthorized requests may receive a login page or `401` response.

This is deployment access control, not necessarily a Qwen service failure.

Vercel access protection and SightJarvis’s internal demonstration login are separate mechanisms.

### Security Requirements Before Public Production Use

The current application uses frontend-only demonstration authentication. It must not be treated as a security boundary for a public production service.

Before public deployment, add or configure:

- Server-side authentication and authorization.
- Model endpoint rate limiting, spending limits, and abuse prevention.
- Appropriate deployment access controls.
- User-facing data disclosures and a suitable privacy policy.
- Error monitoring and safe logging.

Keeping the API key server-side does not, by itself, protect public endpoints from abuse or unexpected costs.

## 9. Mobile and Audio Setup

For first use:

1. Open the application. If the demonstration login screen appears, choose the appropriate demo or guest option.
2. Press the start control.
3. Allow camera and microphone access.
4. Press `Test Sound` and confirm that the device audibly plays the audio-enabled confirmation.
5. Wait for a valid observation to appear in the Timeline before asking a scene question.

The implementation described here still uses the legacy spoken confirmation, `SightLoop audio enabled.` This is an existing application string, not the current project name.

During a genuine user interaction, audio unlocking attempts to:

- Initialize or resume an `AudioContext`.
- Prepare a reusable remote audio element.
- Start media playback.
- Test browser speech synthesis.

When native remote audio is unavailable, the application attempts text plus browser speech synthesis. Audible output cannot be guaranteed when the browser does not support the required capabilities.

On iPhone, also check media volume, Silent Mode, Bluetooth devices, and the selected audio output route.

Speech recognition, speech synthesis, and vibration support vary across browsers and devices. Haptic feedback is not universally available, and installing the PWA does not make model inference available offline.

## 10. Diagnostics and Troubleshooting

### Camera Preview Works, but Analysis Fails

Preview runs locally in the browser. Visual analysis additionally depends on upload, the server, model permissions, and inference requests.

Check:

- Browser request status.
- Vercel function logs.
- API key and endpoint compatibility.
- Model access.
- Rate limits, timeouts, and deployment access protection.

A working preview is not proof of a working visual inference path.

### The Application Starts in `FALLBACK`

Inspect the actual connection state and reported error.

`FALLBACK` means the native WebRTC path was not established and the application is using alternative interaction paths. It does not necessarily mean the entire application is offline.

Possible causes include:

- A missing workspace-specific endpoint.
- A mismatch between region, key, or model permissions.
- Incomplete WebRTC, ICE, DataChannel, or session configuration.

### The Timeline Repeatedly Shows Late Observations

The model result arrived after the current-view validity window.

Within the allowed limits, delayed results remain useful for historical memory and Timeline reasoning. Do not simply remove freshness checks to use them for immediate directional guidance.

### Answers Describe a Scene from Several Seconds Ago

Ordinary scene questions prioritize recent evidence to avoid waiting for a new scan every time.

To inspect a new frame, use the manual scan control or an explicit detailed request such as:

```text
详细看看这里
```

### Memory Does Not Carry Over to a New Deployment

Browser storage is isolated by origin. Changing the Preview domain, switching browsers, or clearing site data can make previous memory unavailable.

### Checking Service Configuration

```bash
curl http://localhost:3000/api/health
```

`/api/health` checks whether a server-side API key is present and whether the realtime endpoint satisfies the current configuration rules.

**It does not call a model. A successful health response does not prove that the key is valid, account funds are sufficient, model access is enabled, or WebRTC is connected.**

### Inspecting Latency

Agent View exposes connection details and available measurements for ASR, the first model event, first audio, total turn duration, and vision requests.

Timeline reasoning also records:

```text
Reasoning from visual timeline
Timeline answer completed
```

Measurement coverage differs between paths. An unavailable metric must not be interpreted as zero latency.

## 11. Testing and Validation

### Local Checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

For the Timeline fix described in this document, all four checks passed locally, with **41 automated tests**. This is the recorded validation of that code version, not a claim that a fresh test run was performed for this documentation-only rename.

Coverage includes:

- WebRTC failure must not report a successful connection.
- A closed DataChannel must not silently lose a question.
- Continuous speech recognition must not resubmit historical transcripts.
- Greetings must not create persistent visual goals.
- English and Chinese intent classification.
- Stale observations must not trigger current-scene warnings.
- Delayed observations may update historical memory only.
- Camera movement must not directly imply object removal.
- Multi-frame verification and conservative temporal reasoning.
- Scan cancellation, timeouts, and model request ordering.
- Safari audio fallback policy.
- Timeline evidence age limits and historical status.
- Correct receiver behavior for the default manual-scan `fetch` call.

Passing automated checks does not establish that every browser or physical device has passed testing.

### Live API Smoke Test

After starting the local server and configuring the key:

```bash
npm run smoke:api
```

This script uses a synthetic image to exercise background vision, fast scanning, Max, and OCR.

**It sends real model requests and may incur charges.**

It does not validate camera permissions, WebRTC audio, the iPhone speaker, or recognition accuracy in real scenes.

### Suggested Physical-Device Acceptance Test

1. Say “Hello” and verify that no unrelated approaching warning interrupts.
2. Ask “What can you see?” and verify that the previous transcript is not repeated.
3. Confirm that the answer matches current evidence or explicitly identified recent observations.
4. Use Test Sound and verify audible output.
5. Scan objects such as a red cup, medicine bottle, USB drive, and greeting card; record omissions and false detections.
6. Observe an object and later ask for its location; verify that “currently visible” and “last seen” remain distinct.
7. Complete at least five consecutive turns and check for lost questions, repeated speech, and resumed background sampling.
8. Repeat under weak-network conditions, page transitions, and different audio routes.

## 12. Safety, Privacy, and Limitations

### Raw Media

The application does not intentionally record or persist raw camera video.

Sampled images are transmitted to the model service. WebRTC may transmit audio and video. Browser speech recognition may also depend on a browser vendor’s service.

Therefore, **not storing raw video does not mean media remains entirely on the device, nor does it describe the upstream provider’s data handling policies.**

### Local Data

Structured memory may contain sensitive information about personal objects and their locations. Users on shared devices should understand the site’s storage behavior and clear site data when appropriate.

Current demo accounts support frontend workflows and local memory namespaces only. They do not provide a secure isolation boundary.

Signing out does not mean that all local memory has been deleted.

### Recognition and Reasoning

- Color recognition depends on lighting, exposure, and white balance.
- Small-object recognition depends on distance, focus, occlusion, and sampling resolution.
- Bounding boxes are drawn only when valid coordinates are returned.
- Model confidence is not a safety-certified probability.
- Similar objects may be confused; reliable cross-scene re-identification is not provided.
- OCR must not be used as the sole basis for high-risk decisions such as confirming medication dosage.
- Basic approaching-object events remain in the diagnostic Timeline by default and do not proactively interrupt users.
- Historical imagery must not be used as direct evidence for current navigation decisions.

## 13. Repository Structure and Further Reading

Main directories:

- `app/api/`: Server-side model endpoints.
- `src/components/`: Main application interface and interaction coordination.
- `src/media/`: Camera, audio, sampling, and media lifecycle management.
- `src/providers/`: Model interfaces and output normalization.
- `src/agent/`: Goals, intent parsing, state machine, Timeline reasoning, and tool dispatch.
- `src/memory/`: Working memory, object events, and detailed scene caching.
- `src/temporal/`: Lightweight tracking and temporal evidence reasoning.
- `src/performance/`: Adaptive sampling quality and performance measurements.
- `src/auth/`: Demonstration authentication.
- `src/config/`: Model and environment configuration.
- `src/tests/`: Automated tests.
- `docs/`: Architecture, safety, performance, and usage documentation.

Further reading:

- [Architecture](docs/ARCHITECTURE.md)
- [Agent Design](docs/AGENT_DESIGN.md)
- [Performance and Backpressure](docs/PERFORMANCE.md)
- [Safety and Privacy](docs/SAFETY.md)
- [API Setup](docs/API_SETUP.md)
- [Demo Guide](docs/DEMO.md)
- [Libraries](docs/LIBRARIES.md)

Before contributing, read [`AGENTS.md`](AGENTS.md) and [`SKILL.md`](SKILL.md).

Preserve three essential boundaries when making changes: **keep secrets server-side, prioritize the latest frame, and never present historical evidence as a current fact.**
