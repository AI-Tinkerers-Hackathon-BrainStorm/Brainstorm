import { z } from "zod";

const serverEnvSchema = z.object({
  DASHSCOPE_API_KEY: z.string().min(1).optional(),
  DASHSCOPE_BASE_URL: z.string().url().optional(),
});

export function getServerEnv() {
  return serverEnvSchema.parse({
    DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
    DASHSCOPE_BASE_URL: process.env.DASHSCOPE_BASE_URL,
  });
}
