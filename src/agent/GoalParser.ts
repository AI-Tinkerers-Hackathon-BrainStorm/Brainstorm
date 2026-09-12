import type { AgentGoal } from "../types/index.ts";
import { COLOR_PATTERNS, extractColor } from "./ObjectIdentity.ts";

export type UserIntent =
  | { kind: "PERSISTENT_GOAL"; goalType: AgentGoal["type"] }
  | { kind: "EPHEMERAL_VISUAL_QA"; detailed: true }
  | { kind: "GENERAL_CONVERSATION" };

function goalTypeFor(command: string): AgentGoal["type"] | undefined {
  const lower = command.toLowerCase();
  if (/\b(find|locate|look for)\b|(?:帮我|帮忙|请)?(?:找|寻找|定位)(?:到|一下)?/.test(lower)) return "find";
  if (/\b(read|what does .* say)\b|(?:帮我|请)?(?:读|念)(?:一下|出来|出)?|识别(?:一下)?(?:文字|字)/.test(lower)) return "read";
  if (/\b(remember|keep track)\b|(?:帮我|请)?(?:记住|记下)/.test(lower)) return "remember";
  if (/\b(where(?:'s| is| are| was| did)|last see|do you remember)\b|(?:在哪[儿里]?|去哪[儿里]?了?|不见了|到哪去了|放哪[儿里]?了?)|上次(?:看见|看到)/.test(lower)) return "review";
  if (/\b(keep watching|watch continuously|monitor)\b|帮我看着|持续(?:看|观察|留意)/.test(lower)) return "explore";
  return undefined;
}

export function parseUserIntent(command: string): UserIntent {
  const text = command.trim();
  const goalType = goalTypeFor(text);
  if (goalType) return { kind: "PERSISTENT_GOAL", goalType };
  if (/(?:我)?(?:现在)?(?:前面|面前|前方|眼前)(?:现在)?(?:都)?(?:有|是)?(?:些)?(?:什么|啥|哪些)(?:东西|物品)?|(?:你)?(?:能)?看(?:到|见).*(?:什么|啥|哪些)|(?:画面|镜头|视野)(?:里|中|内)?(?:有|是).*(?:什么|啥|哪些)|(?:帮我|请)?看(?:看|一下)(?:我)?(?:前面|面前|前方|这里|当前画面)|桌(?:子|面)上(?:有|是).*(?:什么|哪些|啥)|这(?:个|是).*(?:什么|啥)|详细(?:看|看看|扫描)|看看这里|\bwhat(?:'s| is) in front|\bwhat (?:objects? (?:are )?)(?:in front|on (?:the )?table)|\bwhat (?:i )?(?:objects )?can you see|\bdescribe (?:this |the )?(?:view|scene)|\btake a (?:detailed )?look\b/i.test(text)) {
    return { kind: "EPHEMERAL_VISUAL_QA", detailed: true };
  }
  return { kind: "GENERAL_CONVERSATION" };
}

export function parseGoal(command: string, now = Date.now()): AgentGoal {
  const normalized = command.trim().replace(/[.!?？！]+$/, "");
  const type = goalTypeFor(normalized) ?? "explore";

  const stripped = normalized
    .replace(/^(please\s+)?(help me\s+)?(find|locate|look for|read|remember where i put|remember|keep track of|where is|where are|where was|where did i put)\s+/i, "")
    .replace(/^(请)?(帮我|帮忙)?(找|寻找|定位)(到|一下)?/i, "")
    .replace(/^(请)?(帮我)?(读|念)(一下|出来|出)?/i, "")
    .replace(/^(请)?(帮我)?(记住|记下)/i, "")
    .replace(/^(my|the|a|an)\s+/i, "")
    .replace(/^我的?/, "")
    .replace(/(?:在哪[儿里]?|去哪[儿里]?了?|不见了|到哪去了|放哪[儿里]?了?)$/u, "")
    .replace(/的/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const color = extractColor(stripped);
  const colorPattern = COLOR_PATTERNS.find((item) => item.pattern.test(stripped))?.pattern;
  const target = colorPattern ? stripped.replace(colorPattern, "").replace(/\s+/g, " ").trim() : stripped;

  return {
    id: `goal-${now}`,
    type,
    target: target || "the current scene",
    attributes: color ? { color } : {},
    createdAt: now,
    fastMode: /\bquick(ly)?\b/i.test(command),
  };
}
