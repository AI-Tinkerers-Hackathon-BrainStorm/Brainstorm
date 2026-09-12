import type { AgentGoal } from "../types/index.ts";

const COLORS: Array<{ pattern: RegExp; value: string }> = [
  { pattern: /\bred\b|红色?/, value: "red" },
  { pattern: /\borange\b|橙色?/, value: "orange" },
  { pattern: /\byellow\b|黄色?/, value: "yellow" },
  { pattern: /\bgreen\b|绿色?/, value: "green" },
  { pattern: /\bblue\b|蓝色?/, value: "blue" },
  { pattern: /\bpurple\b|紫色?/, value: "purple" },
  { pattern: /\bpink\b|粉色?/, value: "pink" },
  { pattern: /\bblack\b|黑色?/, value: "black" },
  { pattern: /\bwhite\b|白色?/, value: "white" },
  { pattern: /\bgr(?:a|e)y\b|灰色?/, value: "gray" },
  { pattern: /\bbrown\b|棕色?/, value: "brown" },
];

export type UserIntent =
  | { kind: "PERSISTENT_GOAL"; goalType: AgentGoal["type"] }
  | { kind: "EPHEMERAL_VISUAL_QA"; detailed: true }
  | { kind: "GENERAL_CONVERSATION" };

function goalTypeFor(command: string): AgentGoal["type"] | undefined {
  const lower = command.toLowerCase();
  if (/\b(find|locate|look for)\b|(?:帮我|帮忙|请)?(?:找|寻找|定位)(?:到|一下)?/.test(lower)) return "find";
  if (/\b(read|what does .* say)\b|(?:帮我|请)?(?:读|念)(?:一下|出来|出)?|识别(?:一下)?(?:文字|字)/.test(lower)) return "read";
  if (/\b(remember|keep track)\b|(?:帮我|请)?(?:记住|记下)/.test(lower)) return "remember";
  if (/\b(where did|where are|where was|last see|do you remember)\b|(?:我(?:的)?\S*)?(?:放哪|在哪里|在哪儿)|上次(?:看见|看到)/.test(lower)) return "review";
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
  const normalized = command.trim().replace(/[.!?]+$/, "");
  const type = goalTypeFor(normalized) ?? "explore";

  const stripped = normalized
    .replace(/^(please\s+)?(help me\s+)?(find|locate|look for|read|remember where i put|remember|keep track of|where is|where are|where was|where did i put)\s+/i, "")
    .replace(/^(请)?(帮我|帮忙)?(找|寻找|定位)(到|一下)?/i, "")
    .replace(/^(请)?(帮我)?(读|念)(一下|出来|出)?/i, "")
    .replace(/^(请)?(帮我)?(记住|记下)/i, "")
    .replace(/^(my|the|a|an)\s+/i, "")
    .replace(/^我的?/, "")
    .trim();
  const colorMatch = COLORS.find((item) => item.pattern.test(stripped));
  const color = colorMatch?.value;
  const target = colorMatch ? stripped.replace(colorMatch.pattern, "").replace(/\s+/g, " ").trim() : stripped;

  return {
    id: `goal-${now}`,
    type,
    target: target || "the current scene",
    attributes: color ? { color } : {},
    createdAt: now,
    fastMode: /\bquick(ly)?\b/i.test(command),
  };
}
