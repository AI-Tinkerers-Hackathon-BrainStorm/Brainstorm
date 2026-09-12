# API setup

SightLoop uses Alibaba Cloud Model Studio through server-side routes. Copy `.env.example` to `.env.local` and set:

```text
DASHSCOPE_API_KEY=your_key
```

Do not use a `NEXT_PUBLIC_` prefix. The browser never receives the long-lived key.

The default compatible endpoint can serve text and vision, but Qwen WebRTC requires a workspace-specific domain. For a Beijing key, set the full compatible base URL:

```text
DASHSCOPE_BASE_URL=https://YOUR_WORKSPACE.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
```

or:

```text
DASHSCOPE_BASE_URL=https://YOUR_WORKSPACE.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
```

The server derives the realtime signaling endpoint from that origin. Keys, workspaces, and base URLs are region-specific and must match. If this variable is missing or points at the legacy global endpoint, SightLoop deliberately reports `FALLBACK` while keeping text and sampled HTTPS vision available.

Optional overrides:

```text
QWEN_REALTIME_MODEL=qwen3.5-omni-flash-realtime
QWEN_VISION_MODEL=qwen3.8-flash
QWEN_DEEP_VISION_MODEL=qwen3.8-max
QWEN_OCR_MODEL=qwen3.5-ocr
```

Official references: [Qwen Omni Realtime](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/realtime), [OpenAI-compatible multimodal chat](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions), and [temporary API keys](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/generate-temporary-api-key).
