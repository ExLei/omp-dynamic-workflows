export const meta = {
  name: "defensive_json_parsing",
  description: "Parse agent() text output as JSON defensively when schema isn't used, flagging unparseable results instead of reading undefined fields",
  phases: [{ title: "Extract" }],
};

// 在提示词中要求模型「返回 STRICT JSON」并不会改变 agent() 的返回内容：
// 未指定 `schema` 时，结果始终是 assistant 的原始文本。从未解析的文本上
// 读取字段（或者笼统地从纯文本的 agent() 调用上读取）会静默失败——
// `result.verdict` 是 `undefined` 而不是错误；成批这样的调用看起来可能
// 完全「成功」，而下游每个聚合器拿到的都是 undefined。只要输出结构重要，
// 就优先使用 `schema` 选项（见 structured-output.js）；仅当确实无法使用
// schema 时才用本模式（例如无法做 schema 校验的 agentType/model）。
function parseOrFlag(text, requiredKeys) {
  if (typeof text !== "string") return { ok: false, raw: text };
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : text;
  let value;
  try {
    value = JSON.parse(candidate.trim());
  } catch {
    return { ok: false, raw: text };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, raw: text };
  for (const key of requiredKeys) {
    if (!(key in value)) return { ok: false, raw: text };
  }
  return { ok: true, value };
}

// ADAPT: 校验并限制 work，再把必填字段精简到下游 JavaScript 所需的最小集合。
const work = args && Array.isArray(args.work) ? args.work.slice(0, 8) : [{ id: "sample" }];
const requiredKeys = ["verdict", "reason"];
const outputs = [];
const missing = [];
const unparseable = [];

phase("Extract");
for (let index = 0; index < work.length; index++) {
  const item = work[index];
  const id = String(item.id);
  const result = await agent(
    `Review this item and return STRICT JSON only, no prose: {"verdict": "pass" | "fail", "reason": string}. Item: ${JSON.stringify(item)}`,
    { label: `defensive:${index}:${id}` },
  );
  if (result === null) {
    missing.push(id);
    outputs.push({ id, status: "missing", verdict: null });
    continue;
  }
  const parsed = parseOrFlag(result, requiredKeys);
  if (!parsed.ok) {
    unparseable.push(id);
    outputs.push({ id, status: "unparseable", verdict: null });
    continue;
  }
  // INVARIANT: 只有在 parseOrFlag 确认必填键存在之后才允许访问字段。
  outputs.push({ id, status: "complete", verdict: parsed.value.verdict });
}

return { outputs, missing, unparseable, complete: missing.length === 0 && unparseable.length === 0 };
