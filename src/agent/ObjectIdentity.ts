export const COLOR_PATTERNS: Array<{ pattern: RegExp; value: string }> = [
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

const COLOR_ALIASES: Record<string, string[]> = {
  red: ["red", "红色", "红"],
  orange: ["orange", "橙色", "橙"],
  yellow: ["yellow", "黄色", "黄"],
  green: ["green", "绿色", "绿"],
  blue: ["blue", "蓝色", "蓝"],
  purple: ["purple", "紫色", "紫"],
  pink: ["pink", "粉色", "粉"],
  black: ["black", "黑色", "黑"],
  white: ["white", "白色", "白"],
  gray: ["gray", "grey", "灰色", "灰"],
  brown: ["brown", "棕色", "褐", "棕"],
};

const OBJECT_SYNONYMS: string[][] = [
  ["cup", "mug", "tumbler", "杯子", "茶杯", "马克杯", "水杯"],
  ["bottle", "flask", "瓶子", "水瓶"],
  ["phone", "smartphone", "cellphone", "mobile", "手机"],
  ["key", "keys", "钥匙"],
  ["glasses", "eyeglasses", "spectacles", "眼镜"],
  ["remote", "remote control", "遥控器"],
  ["wallet", "钱包"],
  ["book", "notebook", "书", "本子"],
  ["laptop", "notebook computer", "电脑", "笔记本"],
  ["charger", "cable", "充电器", "充电线", "线"],
  ["card", "贺卡", "卡片", "卡"],
  ["medicine", "pill bottle", "medicine bottle", "药瓶", "药"],
  ["quilt", "blanket", "comforter", "duvet", "被子", "毯子"],
  ["pillow", "枕头"],
  ["bag", "backpack", "purse", "包", "背包"],
  ["pen", "pencil", "笔"],
  ["watch", "手表"],
  ["headphones", "earbuds", "耳机"],
  ["mouse", "鼠标"],
  ["keyboard", "键盘"],
  ["chair", "椅子"],
  ["table", "desk", "桌子", "桌面"],
];

export function prefersChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

export function normalizeToken(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[的\s\p{P}\p{S}]+/gu, "");
}

export function extractColor(text: string): string | undefined {
  return COLOR_PATTERNS.find((item) => item.pattern.test(text))?.value;
}

export function colorsMatch(a?: string, b?: string): boolean {
  if (!a || !b) return !a && !b ? true : !a || !b;
  const left = normalizeToken(a);
  const right = normalizeToken(b);
  if (left === right) return true;
  return Object.values(COLOR_ALIASES).some((aliases) => {
    const normalized = aliases.map(normalizeToken);
    return normalized.includes(left) && normalized.includes(right);
  });
}

export function labelsMatch(a: string, b: string): boolean {
  const left = normalizeToken(a);
  const right = normalizeToken(b);
  if (!left || !right) return false;
  if (left === right || left.includes(right) || right.includes(left)) return true;
  return OBJECT_SYNONYMS.some((group) => {
    const normalized = group.map(normalizeToken);
    return normalized.includes(left) && normalized.includes(right);
  });
}

export function isTransientBodyPart(label: string): boolean {
  return /^(person|people|human|man|woman|child|hand|hands|face|finger|arm|hair|skin|人|人物|男人|女人|儿童|手|手掌|手指|手臂|脸)$/i.test(label.trim());
}

export function subjectKey(color: string | undefined, label: string): string {
  return [color, label].filter(Boolean).join(" ").trim();
}

function stripColor(text: string): string {
  const pattern = COLOR_PATTERNS.find((item) => item.pattern.test(text))?.pattern;
  return pattern ? text.replace(pattern, "").replace(/\s+/g, " ").trim() : text.trim();
}

export function queryMatchesSubject(query: string, subject: string, color?: string): boolean {
  const queryColor = extractColor(query);
  const subjectColor = color ?? extractColor(subject);
  if (queryColor && (!subjectColor || !colorsMatch(queryColor, subjectColor))) return false;
  return labelsMatch(stripColor(query) || query, stripColor(subject) || subject);
}
