import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CapabilityClassification,
  CapabilitySupport,
  type OptionDescriptor,
  type StaticCapabilityFact,
  WORKFLOW_CAPABILITY_CONTRACT,
} from "./workflow-capability-contract.js";

const GENERATED_MARKER = "<!-- GENERATED from WORKFLOW_CAPABILITY_CONTRACT; do not edit by hand. -->";
const TABLE_START = "<!-- BEGIN GENERATED SUPPORTED WORKFLOW CAPABILITIES -->";
const TABLE_END = "<!-- END GENERATED SUPPORTED WORKFLOW CAPABILITIES -->";

/** Package-relative compact capability index generated from the contract. */
export const CAPABILITY_INDEX_PATH = "skills/workflow-authoring/references/capabilities.md";

/** Package-relative exhaustive generated capability reference. */
export const CAPABILITY_DETAIL_PATH = "skills/workflow-authoring/references/capability-details.md";

/** Documents that embed the byte-identical supported-capability table. */
export const CAPABILITY_TABLE_PUBLICATION_PATHS = [CAPABILITY_INDEX_PATH] as const;
/** All generated capability publication surfaces checked for drift. */
export const CAPABILITY_PUBLICATION_PATHS = [...CAPABILITY_TABLE_PUBLICATION_PATHS, CAPABILITY_DETAIL_PATH] as const;

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function display(value: string | null): string {
  return value === null ? "—" : `\`${escapeTable(value)}\``;
}

function optionText(option: OptionDescriptor): string {
  const required = option.optional ? "可选" : "必填";
  const defaultValue = option.default === null ? "" : `；默认：${option.default}`;
  const constraints = option.constraints.length === 0 ? "" : `；${option.constraints.join("；")}`;
  const dynamic = option.dynamicReference === null ? "" : `；动态引用：${option.dynamicReference}`;
  return `- \`${option.name}\`：${option.type}（${required}${defaultValue}${constraints}${dynamic}）`;
}

function compactOptions(fact: StaticCapabilityFact): string {
  if (!fact.options) return "—";
  return fact.options.options
    .map((option) => {
      const optionality = option.optional ? "可选" : "必填";
      const defaultValue = option.default === null ? "" : `；默认：${option.default}`;
      return `\`${escapeTable(option.name)}\`：${escapeTable(option.type)}（${optionality}${escapeTable(defaultValue)}）`;
    })
    .join("<br>");
}

function publishedFacts(): readonly StaticCapabilityFact[] {
  return WORKFLOW_CAPABILITY_CONTRACT.projectStaticReferenceFacts().filter(
    (fact) =>
      fact.support === CapabilitySupport.SUPPORTED &&
      (fact.classification === CapabilityClassification.RUNTIME_GLOBAL ||
        fact.classification === CapabilityClassification.WORKFLOW_TOOL_INPUT),
  );
}

/** The byte-identical generated block embedded in every public documentation surface. */
export function renderSupportedCapabilityTable(): string {
  const rows = publishedFacts().map(
    (fact) =>
      `| ${escapeTable(fact.label)} | ${fact.classification} | ${display(fact.signature)} | ${compactOptions(fact)} |`,
  );
  return `${TABLE_START}
| 名称 | 分类 | 签名 | 选项与默认值 |
| --- | --- | --- | --- |
${rows.join("\n")}
${TABLE_END}`;
}

function replaceSupportedCapabilityTable(document: string): string | null {
  const start = document.indexOf(TABLE_START);
  const end = document.indexOf(TABLE_END, start + TABLE_START.length);
  if (start < 0 || end < 0 || document.indexOf(TABLE_START, start + TABLE_START.length) >= 0) return null;
  const after = end + TABLE_END.length;
  return `${document.slice(0, start)}${renderSupportedCapabilityTable()}${document.slice(after)}`;
}

/** Regenerates only contract-owned content, preserving hand-written prose around marked blocks. */
export function writeWorkflowCapabilityPublications(root: string): void {
  for (const path of CAPABILITY_TABLE_PUBLICATION_PATHS) {
    const absolutePath = join(root, path);
    if (path === CAPABILITY_INDEX_PATH) {
      writeFileSync(absolutePath, renderWorkflowCapabilityReference());
      continue;
    }
    const source = readFileSync(absolutePath, "utf8");
    const refreshed = replaceSupportedCapabilityTable(source);
    if (refreshed === null) throw new Error(`Missing or duplicate generated capability-table anchors in ${path}.`);
    writeFileSync(absolutePath, refreshed);
  }
  writeFileSync(join(root, CAPABILITY_DETAIL_PATH), renderWorkflowCapabilityDetails());
}

/** Returns every stale surface in stable publication order. Overrides are useful to CI callers and tests. */
export function checkWorkflowCapabilityPublications(
  root: string,
  overrides: Readonly<Partial<Record<(typeof CAPABILITY_PUBLICATION_PATHS)[number], string>>> = {},
): string[] {
  const stale: string[] = [];
  for (const path of CAPABILITY_TABLE_PUBLICATION_PATHS) {
    const actual = overrides[path] ?? readFileSync(join(root, path), "utf8");
    if (path === CAPABILITY_INDEX_PATH) {
      if (actual !== renderWorkflowCapabilityReference()) stale.push(path);
      continue;
    }
    const refreshed = replaceSupportedCapabilityTable(actual);
    if (refreshed === null || refreshed !== actual) stale.push(path);
  }
  const details = overrides[CAPABILITY_DETAIL_PATH] ?? readFileSync(join(root, CAPABILITY_DETAIL_PATH), "utf8");
  if (details !== renderWorkflowCapabilityDetails()) stale.push(CAPABILITY_DETAIL_PATH);
  return stale;
}

function anchorFor(fact: StaticCapabilityFact): string {
  const anchor = fact.reference?.split("#")[1];
  if (!anchor) throw new Error(`Static capability fact ${fact.id} has no reference anchor.`);
  return anchor;
}

function detail(fact: StaticCapabilityFact): string {
  const lines = [
    `<a id="${anchorFor(fact)}"></a>`,
    `## ${fact.label}`,
    "",
    `- 分类：\`${fact.classification}\``,
    `- 支持：\`${fact.support}\``,
    `- 签名：${display(fact.signature)}`,
  ];
  if (fact.options) {
    lines.push(`- 选项结构：\`${fact.options.id}\``, ...fact.options.options.map(optionText));
  }
  if (fact.constraints.length > 0) lines.push(...fact.constraints.map((constraint) => `- 约束：${constraint}`));
  if (fact.dynamicReference) {
    lines.push(
      `- 动态引用归属：\`${fact.dynamicReference.owner}\``,
      `- 条目结构：\`${fact.dynamicReference.itemShape}\``,
      `- 未来查找连接：\`${fact.dynamicReference.connection}\``,
      "- 此静态引用有意不包含动态值。",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Compact generated entrypoint for ordinary exact-name and signature lookup. */
/** Render the compact index that routes exact lookups to exhaustive details. */
export function renderWorkflowCapabilityReference(): string {
  const { definition } = WORKFLOW_CAPABILITY_CONTRACT;
  return `${GENERATED_MARKER}
# 工作流能力索引

契约格式：\`${definition.versions.format.version}\`<br>
契约内容 / 技能 / 扩展：\`${definition.versions.content.version}\`

本紧凑的生成索引覆盖受支持的运行时全局与工作流工具输入。涉及约束、兼容行为、内部边界与动态引用归属时，请跟随[穷尽生成事实](capability-details.md)。

## 支持的能力索引

${renderSupportedCapabilityTable()}
`;
}

/** Exhaustive generated fact projection and stable anchor owner. */
/** Render exhaustive static facts while leaving live catalogues as dynamic references. */
export function renderWorkflowCapabilityDetails(): string {
  const { definition } = WORKFLOW_CAPABILITY_CONTRACT;
  const facts = WORKFLOW_CAPABILITY_CONTRACT.projectStaticReferenceFacts();

  return `${GENERATED_MARKER}
# 详尽的工作流能力事实

契约格式：\`${definition.versions.format.version}\`<br>
契约内容 / 技能 / 扩展：\`${definition.versions.content.version}\`

下方每条确切事实均由已安装扩展的能力契约投影而来。解释性判断应放在本文件旁的手写参考文档中。

${facts.map(detail).join("\n")}`;
}
