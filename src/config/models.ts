export const MODELS = {
  realtimePrimary: process.env.QWEN_REALTIME_MODEL ?? "qwen3.5-omni-flash-realtime",
  realtimeUpgrade: "qwen3.5-omni-plus-realtime",
  conversationFallback: process.env.QWEN_TEXT_MODEL ?? "qwen3.8-flash",
  deepVision: process.env.QWEN_VISION_MODEL ?? "qwen3.8-flash",
  deepVisionMax: process.env.QWEN_DEEP_VISION_MODEL ?? "qwen3.8-max",
  ocr: process.env.QWEN_OCR_MODEL ?? "qwen3.5-ocr",
} as const;

/**
 * Voice for the realtime model. Read in browser code, so the override has to
 * carry the NEXT_PUBLIC_ prefix; a voice name is not a secret.
 *
 * Harvey is documented as a low, mellow male voice. The published voice table
 * covers Qwen3.5-Omni-Realtime while the older Flash generation has a reduced
 * set, so if the provider rejects this name set the variable to a voice the
 * configured model accepts, such as Ethan.
 */
export const REALTIME_VOICE = process.env.NEXT_PUBLIC_QWEN_REALTIME_VOICE ?? "Harvey";

export const DASHSCOPE_BASE_URL = (
  process.env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1"
).replace(/\/$/, "");
