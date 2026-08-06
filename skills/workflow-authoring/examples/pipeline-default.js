export const meta = {
  name: "pipeline_default",
  description: "默认 pipeline：每个维度先审查、完成后立即验证自己的发现，无屏障",
  phases: [{ title: "Review" }, { title: "Verify" }],
};

// ADAPT: 定义适合任务的维度（审查角度/文件/检查项），每项自带审查提示词。
const DIMENSIONS = [
  { key: "bugs", prompt: "Review the diff for correctness bugs." },
  { key: "perf", prompt: "Review the diff for performance regressions." },
];

const FINDINGS_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          title: { type: "string" },
        },
        required: ["file", "line", "title"],
      },
    },
  },
  required: ["findings"],
};

// INVARIANT: 多阶段默认 pipeline——条目之间并发推进、无屏障。
// 维度 'bugs' 的验证与维度 'perf' 的审查同时进行，不浪费墙钟时间。
// 屏障（parallel 等齐）只在需要跨条目上下文时使用，见 pattern-selection 的屏障判据。
const results = await pipeline(
  DIMENSIONS,
  (d) =>
    agent(d.prompt, { label: `review:${d.key}`, phase: "Review", schema: FINDINGS_SCHEMA }).then((r) =>
      (r && r.findings) || [],
    ),
  (findings, d) =>
    parallel(
      findings.map((f) => () =>
        agent(
          `Adversarially verify this finding and return { isReal: boolean }:\n${f.title} (${f.file}:${f.line})`,
          {
            label: `verify:${d.key}:${String(f.file).split("/").pop()}:${f.line}`,
            phase: "Verify",
            schema: {
              type: "object",
              properties: { isReal: { type: "boolean" } },
              required: ["isReal"],
            },
          },
        ).then((v) => ({ ...f, isReal: v ? v.isReal === true : false })),
      ),
    ),
);

const confirmed = results.flat().filter((f) => f.isReal);
return { confirmed };
