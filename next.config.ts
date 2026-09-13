import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Development only. When the browser reaches the dev server through a tunnel
  // domain, Next rejects its own internal requests (including the HMR
  // websocket) unless that origin is listed here. Ignored in production.
  allowedDevOrigins: ["*.trycloudflare.com", "*.ngrok-free.dev"],
  outputFileTracingIncludes: {
    "/api/transcribe": ["./.whisper/whisper-cli", "./.whisper/ggml-base-q5_1.bin"],
  },
};

export default nextConfig;
