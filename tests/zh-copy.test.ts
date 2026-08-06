import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const srcFiles = readdirSync("src").filter((f) => f.endsWith(".ts") && f !== "omp-api.ts" && f !== "omp-host.ts" && f !== "omp-typebox.ts" && f !== "omp-lazy.ts");
const hasCJK = (s: string) => /[\u4e00-\u9fff]/.test(s);

// Extract string literals (double-quoted or backtick) inside a `key: [ ... ]`
// array, walking brackets so a `]` inside a string body doesn't end the scan.
function arrayStringLiterals(text: string, key: string): string[] {
  const out: string[] = [];
  const keyRe = new RegExp(`${key}:\\s*\\[`, "g");
  for (const m of text.matchAll(keyRe)) {
    const start = m.index! + m[0].length;
    // We stand just inside the array's opening `[`, so the walk starts at depth 1.
    let depth = 1;
    let end = text.length;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (c === "[") depth++;
      else if (c === "]") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    for (const s of text.slice(start, end).matchAll(/"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
      out.push(s[1] ?? s[2]);
    }
  }
  return out;
}

describe("zh copy", () => {
  test("every tool description/prompt text is Chinese", () => {
    for (const file of srcFiles) {
      const text = readFileSync(join("src", file), "utf8");
      // plain-string keys: description / promptSnippet
      for (const m of text.matchAll(/(?:description|promptSnippet):\s*"([^"]+)"/g)) {
        expect(hasCJK(m[1]), `${file}: ${m[1]}`).toBe(true);
      }
      // array-form keys: description: [ ... ] / promptGuidelines: [ ... ]
      for (const key of ["description", "promptGuidelines"]) {
        for (const s of arrayStringLiterals(text, key)) {
          expect(hasCJK(s), `${file}: ${key} array: ${s}`).toBe(true);
        }
      }
    }
  });

  test("workflow tool descriptions are Chinese", () => {
    const tool = readFileSync("src/workflow-tool.ts", "utf8");
    expect(hasCJK(tool)).toBe(true);
    const control = readFileSync("src/workflow-control-tool.ts", "utf8");
    expect(hasCJK(control)).toBe(true);
  });

  test("web console has no residual English UI strings", () => {
    const webFiles = ["App.tsx", "RunList.tsx", "AgentDrawer.tsx", "SaveDialog.tsx", "index.html"];
    for (const f of webFiles) {
      const candidates =
        f === "index.html"
          ? [join("web", f)]
          : [join("web/src", f), join("web/src/components", f)];
      const p = candidates.find((candidate) => {
        try {
          readFileSync(candidate, "utf8");
          return true;
        } catch {
          return false;
        }
      });
      expect(p, `${f} not found under web/src or web/src/components`).toBeDefined();
      const text = readFileSync(p!, "utf8");
      for (const word of ["Running", "Paused", "Failed", "Completed", "Save workflow", "Open console", "Stop", "Resume"]) {
        expect(text, `${f} contains ${word}`).not.toContain(word);
      }
    }
  });
});
