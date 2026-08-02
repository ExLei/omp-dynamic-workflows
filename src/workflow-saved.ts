/**
 * Save and load reusable workflow commands.
 */

import { USER_WORKFLOW_SAVED_DIR, WORKFLOW_SAVED_DIR } from "./config.js";
import { join } from "node:path";
import {
  ensureDir as ensureDirFs,
  listJsonFilesSafe,
  type PersistenceFsLayer,
  readJsonWithBackupRecovery,
  resolvePersistenceFs,
  unlinkIfExistsSafe,
  writeJsonAtomicWithBackup,
} from "./fs-persistence.js";
import { workflowProjectPaths, workflowUserSavedDir } from "./workflow-paths.js";

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
  /** When it was saved. */
  savedAt: string;
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
  // Project workflows written by an older build still live under the user's
  // home namespace; read them so an upgrade doesn't hide them, but never write
  // there again (save() targets the in-project directory).
  const homeProjectDir = paths.homeSavedDir;
  const userDir = workflowUserSavedDir();

  const ensureDir = (dir: string) => ensureDirFs(fs, dir);

  const workflowPath = (name: string, location: "project" | "user") => {
    assertSafeSavedWorkflowName(name);
    const dir = location === "project" ? projectDir : userDir;
    return join(dir, `${name}.json`);
  };
  const homeProjectWorkflowPath = (name: string) => {
    assertSafeSavedWorkflowName(name);
    return join(homeProjectDir, `${name}.json`);
  };

  // Same atomic-write-with-backup + corrupt-file recovery contract as
  // run-persistence.ts (see fs-persistence.ts) — a saved workflow is a
  // user-authored artifact just as worth protecting from a crash mid-write
  // or a truncated file as a run's resumable state is.
  const loadFromFile = (path: string, location: "project" | "user"): SavedWorkflow | null => {
    const data = readJsonWithBackupRecovery<Record<string, unknown>>(fs, path);
    if (!data || typeof data !== "object" || !isSafeSavedWorkflowName((data as { name?: string }).name ?? "")) {
      return null;
    }
    return {
      ...(data as Omit<SavedWorkflow, "location" | "path">),
      location,
      path,
    };
  };

  return {
    save(workflow, location = "project") {
      assertSafeSavedWorkflowName(workflow.name);
      const dir = location === "project" ? projectDir : userDir;
      ensureDir(dir);

      const path = workflowPath(workflow.name, location);
      const saved: SavedWorkflow = {
        ...workflow,
        location,
        path,
        savedAt: new Date().toISOString(),
      };

      writeJsonAtomicWithBackup(fs, path, saved);
      return saved;
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
        // taking down the whole listing over one bad storage location.
        for (const file of listJsonFilesSafe(fs, dir)) {
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
