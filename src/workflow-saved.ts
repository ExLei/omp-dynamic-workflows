/**
 * Save and load reusable workflow commands.
 *
 * Saved workflows are Claude Code–compatible `.js` modules: a leading
 * `export const meta = { name, description, parameters?, phases?, model? }`
 * block followed by a blank line and the workflow body. Files are written as
 * plain text (no JSON escaping), so a saved workflow doubles as an importable
 * module and stays hand-editable. Legacy `.json` records are intentionally not
 * read, written, or listed — there is no compatibility layer.
 */

import { USER_WORKFLOW_SAVED_DIR, WORKFLOW_SAVED_DIR } from "./config.js";
import { join } from "node:path";
import {
  ensureDir as ensureDirFs,
  type PersistenceFsLayer,
  resolvePersistenceFs,
  unlinkIfExistsSafe,
} from "./fs-persistence.js";
import { workflowProjectPaths, workflowUserSavedDir } from "./workflow-paths.js";
import { parseWorkflowScript, type WorkflowMeta } from "./workflow.js";

export interface SavedWorkflow {
  /** Command name (filename without extension). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** The workflow script. */
  script: string;
  /** Optional parameter schema for parameterized workflows. */
  parameters?: Record<string, { type: string; description?: string; required?: boolean; default?: unknown }>;
  /** Where this workflow is saved. */
  location: "project" | "user";
  /** Full file path. */
  path: string;
  /**
   * When it was saved. Set by `save()`; absent for workflows loaded from
   * disk, because the `.js` format carries no timestamp.
   */
  savedAt?: string;
}

export interface WorkflowStorage {
  /** Save a workflow. */
  save(workflow: Omit<SavedWorkflow, "path" | "savedAt">, location?: "project" | "user"): SavedWorkflow;
  /** Load a workflow by name. */
  load(name: string): SavedWorkflow | null;
  /** List all saved workflows. */
  list(): SavedWorkflow[];
  /**
   * Which locations already hold a workflow of this name. Unlike {@link load}
   * (which resolves precedence to one winner) this reports every hit, so a save
   * picker can warn that a specific destination would be overwritten.
   */
  locationsOf(name: string): Array<"project" | "user">;
  /** Delete a saved workflow. */
  delete(name: string, location?: "project" | "user"): boolean;
}

/** One offered save destination, with the concrete directory it writes to. */
export interface SaveLocationOption {
  location: "project" | "user";
  /** Short label ("Project" / "Personal"), matching the wording Claude Code uses. */
  label: string;
  /** Absolute directory the workflow lands in. */
  dir: string;
  /** Short form of `dir` for menus: `.omp/workflows/saved` / `~/.omp/workflows/saved`. */
  display: string;
}

/**
 * The save destinations offered to the user, project first — a workflow written
 * for this repo belongs beside it, and that is also the default when no choice
 * is made (headless save paths).
 */
export function saveLocationOptions(cwd: string): SaveLocationOption[] {
  const paths = workflowProjectPaths(cwd);
  return [
    { location: "project", label: "Project", dir: paths.projectSavedDir, display: WORKFLOW_SAVED_DIR },
    { location: "user", label: "Personal", dir: workflowUserSavedDir(), display: USER_WORKFLOW_SAVED_DIR },
  ];
}

export function isSafeSavedWorkflowName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 128 &&
    name.trim() === name &&
    name !== "." &&
    name !== ".." &&
    !/[/\\\0]/.test(name)
  );
}

export function assertSafeSavedWorkflowName(name: string): void {
  if (!isSafeSavedWorkflowName(name)) {
    throw new Error("Saved workflow name must be a non-empty path-safe name without slashes.");
  }
}

export function createWorkflowStorage(cwd: string, fsOverride?: Partial<PersistenceFsLayer>): WorkflowStorage {
  const fs = resolvePersistenceFs(fsOverride);
  const paths = workflowProjectPaths(cwd);
  const projectDir = paths.projectSavedDir;
  // Project workflows written before the in-project move live under the
  // user's home namespace; keep reading them (same .js format) so an upgrade
  // doesn't hide them, but never write there again (save() targets the
  // in-project directory).
  const homeProjectDir = paths.homeSavedDir;
  const userDir = workflowUserSavedDir();

  const ensureDir = (dir: string) => ensureDirFs(fs, dir);

  const workflowPath = (name: string, location: "project" | "user") => {
    assertSafeSavedWorkflowName(name);
    const dir = location === "project" ? projectDir : userDir;
    return join(dir, `${name}.js`);
  };
  const homeProjectWorkflowPath = (name: string) => {
    assertSafeSavedWorkflowName(name);
    return join(homeProjectDir, `${name}.js`);
  };

  // Plain-text read with a tolerant contract: a missing, unreadable, or
  // hand-broken file degrades to "not found" rather than crashing a load or
  // taking down a whole listing — the same spirit as the old .json backup
  // recovery's tolerance for corrupt records.
  const loadFromFile = (path: string, location: "project" | "user"): SavedWorkflow | null => {
    let raw: string | null = null;
    try {
      if (fs.existsSync(path)) raw = fs.readFileSync(path, "utf-8");
    } catch {
      raw = null;
    }
    if (raw == null) return null;
    // The .js format is parseWorkflowScript's native format: the first
    // statement must be `export const meta = {...}`, everything after it is
    // the body. A user-edited file can be broken in arbitrary ways, so parse
    // failures (like missing files) mean "no such workflow".
    let parsed: { meta: WorkflowMeta; body: string };
    try {
      parsed = parseWorkflowScript(raw);
    } catch {
      return null;
    }
    if (!parsed.meta.name || !isSafeSavedWorkflowName(parsed.meta.name)) return null;
    return {
      name: parsed.meta.name,
      description: parsed.meta.description,
      parameters: (parsed.meta as WorkflowMeta & { parameters?: SavedWorkflow["parameters"] }).parameters,
      // The full file text is the runnable script: meta header + body, exactly
      // what parseWorkflowScript expects. Consumers (registerSavedWorkflow,
      // loadSavedWorkflow, runSavedShadowIfPresent) feed `script` straight
      // back into parseWorkflowScript to execute it, so it must stay a
      // complete module — not just the body.
      script: raw,
      location,
      path,
      // No savedAt: the .js format carries no timestamp.
    };
  };

  return {
    save(workflow, location = "project") {
      assertSafeSavedWorkflowName(workflow.name);
      const dir = location === "project" ? projectDir : userDir;
      ensureDir(dir);

      const path = workflowPath(workflow.name, location);
      // Claude Code's own format: a `export const meta = {...}` block (the
      // first statement, exactly what parseWorkflowScript expects) followed by
      // the workflow body. Written as plain text — no JSON escaping, and the
      // result is a real importable module.
      //
      // Every runnable workflow script already starts with its own
      // `export const meta` header (parseWorkflowScript requires it); a second
      // header would make the saved file unparseable ("Duplicate export").
      // Embed the script body only — the file's meta block IS the header.
      //
      // The input to save() is a script that already ran (run/parse validated
      // it), so a parse failure here is a programming error: throw and reject
      // the save instead of writing a broken file. Parsing also yields the
      // complete meta, which must be carried into the rebuilt header — phases
      // and model drive per-phase agent routing (parseModelRoutingFromMeta)
      // and TUI phase grouping, so dropping them would silently change the
      // saved workflow's behavior.
      const parsed = parseWorkflowScript(workflow.script);
      const body = parsed.body;
      const metaLines = [`export const meta = {`, `  name: ${JSON.stringify(workflow.name)},`];
      // validateMeta (inside parseWorkflowScript on load) requires a non-empty
      // description, so an empty one falls back to the name — otherwise the
      // saved file would be unreadable and the artifact would silently die.
      metaLines.push(
        `  description: ${JSON.stringify(workflow.description.trim() ? workflow.description : workflow.name)},`,
      );
      if (workflow.parameters) metaLines.push(`  parameters: ${JSON.stringify(workflow.parameters, null, 2)},`);
      if (parsed.meta.phases) {
        // JSON.stringify starts at column 0, but the meta block is 2-space
        // indented — shift continuation lines so the artifact stays readable
        // (and genuinely hand-editable).
        const phases = JSON.stringify(parsed.meta.phases, null, 2)
          .split("\n")
          .map((line, index) => (index === 0 ? line : `  ${line}`))
          .join("\n");
        metaLines.push(`  phases: ${phases},`);
      }
      if (parsed.meta.model) metaLines.push(`  model: ${JSON.stringify(parsed.meta.model)},`);
      metaLines.push("}");
      // Atomic write (tmp + rename on the same filesystem), so a crash
      // mid-write can never leave a truncated .js in place of a good one. No
      // .bak sidecar: the .js format is plain text with no recovery read, and
      // a stale .tmp is invisible to load()/list() (they filter on .js).
      const content = `${metaLines.join("\n")}\n\n${body}\n`;
      fs.writeFileSync(`${path}.tmp`, content);
      fs.renameSync(`${path}.tmp`, path);
      return { ...workflow, location, path, savedAt: new Date().toISOString() };
    },

    load(name: string): SavedWorkflow | null {
      if (!isSafeSavedWorkflowName(name)) return null;
      // Project takes precedence over user
      const projectPath = workflowPath(name, "project");
      const project = loadFromFile(projectPath, "project");
      if (project) return project;

      const homeProject = loadFromFile(homeProjectWorkflowPath(name), "project");
      if (homeProject) return homeProject;

      const userPath = workflowPath(name, "user");
      return loadFromFile(userPath, "user");
    },

    locationsOf(name: string): Array<"project" | "user"> {
      if (!isSafeSavedWorkflowName(name)) return [];
      const hits: Array<"project" | "user"> = [];
      // The home-namespaced copy counts as "project": save() would shadow it
      // and delete() removes it, so the user is effectively replacing it.
      if (loadFromFile(workflowPath(name, "project"), "project") || loadFromFile(homeProjectWorkflowPath(name), "project")) {
        hits.push("project");
      }
      if (loadFromFile(workflowPath(name, "user"), "user")) hits.push("user");
      return hits;
    },

    list(): SavedWorkflow[] {
      const workflows: SavedWorkflow[] = [];

      const seen = new Set<string>();
      const addDir = (dir: string, location: "project" | "user") => {
        // A missing or unreadable directory (not yet created, deleted
        // mid-race, permission-denied) degrades to "no files" here — same
        // guard run-persistence.ts's list() uses — rather than throwing and
        // taking down the whole listing over one bad storage location. Only
        // `.js` modules are workflows; `.json` records are never listed.
        let files: string[] = [];
        try {
          if (fs.existsSync(dir)) files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
        } catch {
          files = [];
        }
        for (const file of files) {
          const wf = loadFromFile(join(dir, file), location);
          if (wf && !seen.has(wf.name)) {
            seen.add(wf.name);
            workflows.push(wf);
          }
        }
      };

      // Priority order mirrors load(): in-project > home-namespaced project > user.
      addDir(projectDir, "project");
      addDir(homeProjectDir, "project");
      addDir(userDir, "user");

      return workflows.sort((a, b) => a.name.localeCompare(b.name));
    },

    delete(name: string, location?: "project" | "user"): boolean {
      if (!isSafeSavedWorkflowName(name)) return false;
      const locations = location ? [location] : (["project", "user"] as const);
      let deleted = false;

      for (const loc of locations) {
        const path = workflowPath(name, loc);
        // Clean up the .bak sidecar too, mirroring run-persistence.ts's delete()
        // (sidecar cleanup does not by itself count as "deleted the workflow").
        unlinkIfExistsSafe(fs, `${path}.bak`);
        if (unlinkIfExistsSafe(fs, path)) {
          deleted = true;
        }
        if (loc === "project") {
          const homePath = homeProjectWorkflowPath(name);
          unlinkIfExistsSafe(fs, `${homePath}.bak`);
          if (unlinkIfExistsSafe(fs, homePath)) {
            deleted = true;
          }
        }
      }

      return deleted;
    },
  };
}
