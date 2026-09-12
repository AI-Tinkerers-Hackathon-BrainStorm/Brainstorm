export const MODELS = {
  realtimePrimary: process.env.QWEN_REALTIME_MODEL ?? "qwen3.5-omni-flash-realtime",
  realtimeUpgrade: "qwen3.5-omni-plus-realtime",
  conversationFallback: process.env.QWEN_TEXT_MODEL ?? "qwen3.8-flash",
  deepVision: process.env.QWEN_VISION_MODEL ?? "qwen3.8-flash",
  deepVisionMax: process.env.QWEN_DEEP_VISION_MODEL ?? "qwen3.8-max",
  ocr: process.env.QWEN_OCR_MODEL ?? "qwen3.5-ocr",
} as const;

export const DASHSCOPE_BASE_URL = (
  process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1"
).replace(/\/$/, "");
