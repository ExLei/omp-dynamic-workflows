export const meta = {
  name: "adversarial_project_comparison",
  description:
    "多模型对抗式对比两个项目的实现方案:侦察 → 双方主张 → 交叉反驳 → 多模型裁决 → 综合报告。args: { a?, b?, aName?, bName?, dimensions?[], focus? }",
  phases: [
    { title: "Recon" },
    { title: "Advocacy" },
    { title: "Rebuttal" },
    { title: "Adjudication" },
    { title: "Synthesis" },
  ],
};

const input = args && typeof args === "object" ? args : {};

const projects = [
  {
    id: "A",
    name: input.aName || "omp-dynamic-workflows",
    path: input.a || cwd,
  },
  {
    id: "B",
    name: input.bName || "pi-dynamic-workflows",
    path: input.b || "C:/Users/zero/Desktop/code/github/pi-dynamic-workflows",
  },
];

const dimensions =
  Array.isArray(input.dimensions) && input.dimensions.length > 0
    ? input.dimensions.slice(0, 8)
    : [
        "架构分层与模块边界",
        "运行时/宿主 API 契合度",
        "可扩展性与可维护性",
        "错误处理与失败恢复",
        "持久化与状态管理",
        "测试与可验证性",
      ];

const focus = typeof input.focus === "string" && input.focus.trim() ? input.focus.trim() : "整体实现方案";

const reconSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    architecture: { type: "array", items: { type: "string" } },
    keyFiles: { type: "array", items: { type: "string" } },
    strengths: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "architecture", "keyFiles", "strengths", "weaknesses"],
};

const judgeSchema = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          dimension: { type: "string" },
          aScore: { type: "number" },
          bScore: { type: "number" },
          reason: { type: "string" },
        },
        required: ["dimension", "aScore", "bScore", "reason"],
      },
    },
    winner: { type: "string" },
    decisiveFactors: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
  },
  required: ["scores", "winner", "decisiveFactors", "risks"],
};

function describe(project, recon) {
  if (!recon) return "项目 " + project.id + " (" + project.name + " @ " + project.path + "):侦察缺失,请自行读取源码后再论证。";
  return [
    "项目 " + project.id + " (" + project.name + " @ " + project.path + ")",
    "概述:" + recon.summary,
    "架构:" + recon.architecture.join("; "),
    "关键文件:" + recon.keyFiles.join("; "),
    "自评优势:" + recon.strengths.join("; "),
    "自评弱点:" + recon.weaknesses.join("; "),
  ].join("\n");
}

// --- Phase 1: 侦察 ------------------------------------------------------
phase("Recon");

const recons = await parallel(
  projects.map(
    (project) => () =>
      agent(
        [
          "阅读项目 " + project.name + " 的源码,目录:" + project.path,
          "任务:提炼它实现『" + focus + "』的方案。",
          "要求:用 glob/grep/read 实际读取代码;只陈述在代码中能被验证的事实,不要臆测。",
          "关注维度:" + dimensions.join("、"),
          "keyFiles 用相对路径,并附一句该文件承担的职责。",
        ].join("\n"),
        { label: "recon-" + project.id, tier: "big", schema: reconSchema },
      ),
  ),
);

const reconById = {};
projects.forEach((project, index) => {
  reconById[project.id] = recons[index] || null;
  if (!recons[index]) log("侦察缺失:项目 " + project.id + " (" + project.name + ")");
});

const dossier = projects.map((project) => describe(project, reconById[project.id])).join("\n\n");

// --- Phase 2: 主张(每个项目由两种模型分别辩护) --------------------------
phase("Advocacy");

const advocacyPlan = [];
for (const project of projects) {
  advocacyPlan.push({ id: project.id + "-big", project: project, tier: "big" });
  advocacyPlan.push({ id: project.id + "-medium", project: project, tier: "medium" });
}

const advocacyResults = await parallel(
  advocacyPlan.map(
    (slot) => () =>
      agent(
        [
          "你是项目 " + slot.project.name + "(编号 " + slot.project.id + ")实现方案的辩护方。",
          "对手是另一项目的实现方案。逐条论证在下列维度上你方为何更优,并明确承认你方确实存在的劣势(隐瞒会被反驳方抓住)。",
          "维度:" + dimensions.join("、"),
          "证据必须落到具体文件与符号;必要时自行读取 " + slot.project.path + " 补足证据。",
          "输出 Markdown:每个维度一节,含『主张』『证据(文件:符号)』『代价』。",
          "\n=== 双方侦察档案 ===\n" + dossier,
        ].join("\n"),
        { label: "advocate-" + slot.id, tier: slot.tier },
      ),
  ),
);

const advocacyById = { A: [], B: [] };
advocacyPlan.forEach((slot, index) => {
  const text = advocacyResults[index];
  if (text) advocacyById[slot.project.id].push({ id: slot.id, tier: slot.tier, text: text });
  else log("主张缺失:" + slot.id);
});

function advocacyText(id) {
  const items = advocacyById[id];
  if (items.length === 0) return "(项目 " + id + " 无可用主张)";
  return items.map((item) => "--- 辩护稿 " + item.id + " ---\n" + item.text).join("\n\n");
}

// --- Phase 3: 交叉反驳 ---------------------------------------------------
phase("Rebuttal");

const rebuttalResults = await parallel(
  projects.map((project, index) => {
    const opponent = projects[(index + 1) % projects.length];
    return () =>
      agent(
        [
          "你代表项目 " + project.name + "(编号 " + project.id + "),对项目 " + opponent.name + "(编号 " + opponent.id + ")的辩护稿逐条反驳。",
          "规则:只反驳能用代码证据证伪或证弱的论点;对方站得住的论点必须明确承认。",
          "每条给出:对方主张 → 反驳 → 证据(文件:符号)→ 置信度(高/中/低)。",
          "\n=== 对方辩护稿 ===\n" + advocacyText(opponent.id),
          "\n=== 侦察档案 ===\n" + dossier,
        ].join("\n"),
        { label: "rebut-" + project.id + "-vs-" + opponent.id, tier: "big" },
      );
  }),
);

const rebuttals = [];
projects.forEach((project, index) => {
  const text = rebuttalResults[index];
  if (text) rebuttals.push({ by: project.id, text: text });
  else log("反驳缺失:项目 " + project.id);
});

const rebuttalText =
  rebuttals.length > 0
    ? rebuttals.map((item) => "--- 由项目 " + item.by + " 提出 ---\n" + item.text).join("\n\n")
    : "(无可用反驳)";

const record = [
  "=== 侦察档案 ===\n" + dossier,
  "=== 项目 A 辩护 ===\n" + advocacyText("A"),
  "=== 项目 B 辩护 ===\n" + advocacyText("B"),
  "=== 交叉反驳 ===\n" + rebuttalText,
].join("\n\n");

// --- Phase 4: 多模型裁决 -------------------------------------------------
phase("Adjudication");

const judgeTiers = ["big", "medium", "small"];

const judgeResults = await parallel(
  judgeTiers.map(
    (tier) => () =>
      agent(
        [
          "你是中立裁判,依据下面的完整对抗记录裁决两个项目实现『" + focus + "』的方案孰优。",
          "对每个维度给 A、B 各 0-10 分(可小数),并写明依据。winner 只能是 \"A\"、\"B\" 或 \"tie\"。",
          "维度(必须逐个覆盖,顺序一致):" + dimensions.join("、"),
          "不迎合任何一方的措辞;缺证据的主张按低分处理。",
          "\n" + record,
        ].join("\n"),
        { label: "judge-" + tier, tier: tier, schema: judgeSchema },
      ),
  ),
);

const judgments = [];
judgeTiers.forEach((tier, index) => {
  const verdict = judgeResults[index];
  if (verdict) judgments.push({ judge: tier, verdict: verdict });
  else log("裁决缺失:judge-" + tier);
});

const tally = {};
for (const dimension of dimensions) tally[dimension] = { a: 0, b: 0, count: 0 };
for (const item of judgments) {
  for (const score of item.verdict.scores) {
    const bucket = tally[score.dimension];
    if (!bucket) continue;
    bucket.a += score.aScore;
    bucket.b += score.bScore;
    bucket.count += 1;
  }
}

const dimensionAverages = [];
let totalA = 0;
let totalB = 0;
for (const dimension of dimensions) {
  const bucket = tally[dimension];
  if (bucket.count === 0) {
    dimensionAverages.push({ dimension: dimension, a: null, b: null, judges: 0 });
    continue;
  }
  const a = bucket.a / bucket.count;
  const b = bucket.b / bucket.count;
  totalA += a;
  totalB += b;
  dimensionAverages.push({ dimension: dimension, a: a, b: b, judges: bucket.count });
}

const votes = { A: 0, B: 0, tie: 0 };
for (const item of judgments) {
  const winner = String(item.verdict.winner).toUpperCase();
  if (winner === "A") votes.A += 1;
  else if (winner === "B") votes.B += 1;
  else votes.tie += 1;
}

const scoreboard = dimensionAverages
  .map((row) =>
    row.judges === 0
      ? row.dimension + ":无有效评分"
      : row.dimension + ":A=" + row.a.toFixed(2) + " B=" + row.b.toFixed(2) + "(" + row.judges + " 位裁判)",
  )
  .join("\n");

// --- Phase 5: 综合(两种模型各出一版,评审团选优) ------------------------
phase("Synthesis");

const synthesisPrompt = [
  "把下面的对抗式对比整理成一份可执行的决策报告(Markdown)。",
  "结构:1) 结论与信心度 2) 维度对照表 3) 各自不可替代的优势 4) 建议吸收到 " + projects[0].name + " 的具体改动(文件级) 5) 明确的分歧与未解风险。",
  "只保留有证据支撑的论断;裁判分歧处要写明分歧本身,不要抹平。",
  "\n=== 裁判均分 ===\n" + scoreboard,
  "胜负票:A=" + votes.A + " B=" + votes.B + " 平=" + votes.tie + ";总分 A=" + totalA.toFixed(2) + " B=" + totalB.toFixed(2),
  "\n" + record,
].join("\n");

const candidates = await parallel([
  () => agent(synthesisPrompt, { label: "synthesis-big", tier: "big" }),
  () => agent(synthesisPrompt, { label: "synthesis-medium", tier: "medium" }),
]);

const usableCandidates = candidates.filter((text) => typeof text === "string" && text.length > 0);
let finalReport = null;
let reportSource = "none";

if (usableCandidates.length === 1) {
  finalReport = usableCandidates[0];
  reportSource = "single";
} else if (usableCandidates.length > 1) {
  const best = await judgePanel(usableCandidates, {
    judges: 2,
    rubric: "证据密度、对分歧的忠实呈现、建议的可执行性;禁止奖励空泛措辞",
  });
  if (best) {
    finalReport = best.attempt;
    reportSource = "panel-index-" + best.index;
  } else {
    finalReport = usableCandidates[0];
    reportSource = "panel-empty-fallback";
  }
} else {
  log("综合报告缺失:两版候选均失败");
}

return {
  focus: focus,
  projects: projects,
  dimensions: dimensions,
  recon: { A: reconById.A, B: reconById.B },
  advocacy: advocacyById,
  rebuttals: rebuttals,
  judgments: judgments,
  scoreboard: { dimensions: dimensionAverages, totals: { A: totalA, B: totalB }, votes: votes },
  missing: {
    recon: projects.filter((project) => !reconById[project.id]).map((project) => project.id),
    advocates: advocacyPlan.filter((slot) => !advocacyById[slot.project.id].some((item) => item.id === slot.id)).map((slot) => slot.id),
    judges: judgeTiers.filter((tier) => !judgments.some((item) => item.judge === tier)),
  },
  finalReport: finalReport,
  reportSource: reportSource,
};
