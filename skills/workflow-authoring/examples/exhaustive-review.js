export const meta = {
  name: "exhaustive_review",
  description: "循环直至干涸：发现 → 与全部 seen 去重 → 3 透镜并行判定 → 连续空轮才停",
  phases: [{ title: "Find" }, { title: "Verify" }],
};

// ADAPT: 定义适合任务的 finder 提示词与发现键函数（键必须稳定、跨轮一致）。
const FINDERS = [
  "Scan for correctness bugs in the diff.",
  "Scan for security issues in the diff.",
];
const key = (f) => `${f.file}:${f.line}:${f.summary}`;
const JUDGE_LENSES = ["correctness", "security", "repro"];

const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    bugs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          summary: { type: "string" },
        },
        required: ["file", "line", "summary"],
      },
    },
  },
  required: ["bugs"],
};

const seen = new Set();
const confirmed = [];
let dry = 0;

// INVARIANT: 与 seen（全部见过）去重，而不是与 confirmed 去重——否则每轮被
// judge 拒绝的发现都会重现，循环永不收敛。
while (dry < 2) {
  // 屏障：本轮所有 finder 都完成后才收集（跨 finder 去重需要全量结果）。
  const found = (await parallel(
    FINDERS.map((prompt, i) => () =>
      agent(prompt, { label: `find:${i}`, phase: "Find", schema: FINDINGS_SCHEMA }).then((r) => (r && r.bugs) || []),
    ),
  ))
    .filter(Boolean)
    .flat();

  const fresh = found.filter((f) => !seen.has(key(f)));
  if (fresh.length === 0) {
    dry++;
    continue;
  }
  dry = 0;
  for (const f of fresh) seen.add(key(f));

  // 每条新鲜发现由 3 个不同透镜并行判定，多数通过（≥2/3）才确认为真。
  const judged = await parallel(
    fresh.map((f) => () =>
      parallel(
        JUDGE_LENSES.map((lens) => () =>
          agent(`Judge "${f.summary}" (${f.file}:${f.line}) via the ${lens} lens — is it real? Return { real: boolean }.`, {
            label: `judge:${lens}:${f.line}`,
            phase: "Verify",
            schema: {
              type: "object",
              properties: { real: { type: "boolean" } },
              required: ["real"],
            },
          }).then((v) => (v ? v.real === true : false)),
        ),
      ).then((votes) => ({ ...f, real: votes.filter(Boolean).length >= 2 })),
    ),
  );
  confirmed.push(...judged.filter((j) => j.real));
}

return { confirmed };
