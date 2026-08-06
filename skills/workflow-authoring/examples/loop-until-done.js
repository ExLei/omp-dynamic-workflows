export const meta = {
  name: "loop_until_done",
  description: "Discover unknown-cardinality findings until repeated successful rounds are dry",
  phases: [{ title: "Discover" }],
};

// ADAPT: 选择目标、稳定的身份字段、schema、空转轮规则与最大上限。
const target = args && typeof args.target === "string" ? args.target : "new findings";
const maxRounds = args && Number.isInteger(args.maxRounds) ? Math.max(1, Math.min(args.maxRounds, 20)) : 6;
const consecutiveDry = 2;
const roundSchema = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, detail: { type: "string" } },
        required: ["id", "detail"],
      },
    },
  },
  required: ["findings"],
};
const failedRounds = [];
const knownIds = new Set();
const findings = [];
let dryRounds = 0;
let roundsRun = 0;

phase("Discover");
while (roundsRun < maxRounds && dryRounds < consecutiveDry) {
  const roundNumber = roundsRun + 1;
  const response = await agent(
    `Find ${target}. Return only findings not represented by these stable IDs: ${JSON.stringify([...knownIds])}`,
    { label: `discover:${roundNumber}`, schema: roundSchema },
  );
  roundsRun++;
  if (response === null) {
    // INVARIANT: 缺失覆盖不能证明某轮为空转，也不能计入连续空转。
    failedRounds.push(roundNumber);
    dryRounds = 0;
    continue;
  }

  const fresh = [];
  for (const finding of response.findings) {
    if (!knownIds.has(finding.id)) {
      knownIds.add(finding.id);
      fresh.push(finding);
    }
  }
  if (fresh.length === 0) dryRounds++;
  else {
    dryRounds = 0;
    findings.push(...fresh);
  }
}

// INVARIANT: 稳定的 ID、连续成功的空转轮与 maxRounds 共同限定探索范围。
const termination = dryRounds >= consecutiveDry ? "dry" : "max-rounds";
return {
  findings,
  failedRounds,
  roundsRun,
  termination,
  complete: failedRounds.length === 0 && termination === "dry",
};
