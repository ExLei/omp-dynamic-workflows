/**
 * Filesystem layout for omp-dynamic-workflows state.
 *
 * Machine-local state (runs, settings) lives under the user's `.omp/workflows`
 * home, isolated per project by a stable cwd-derived namespace. Saved workflows
 * are user-authored artifacts, so a project-scoped one is written INSIDE the
 * project (`<cwd>/.omp/workflows/saved`) where it can be reviewed and committed
 * with the code it automates — the same place Claude Code keeps `.claude`
 * commands. `homeSavedDir` is the pre-move location, still read for compat.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { WORKFLOW_SAVED_DIR } from "./config.js";

export const WORKFLOW_HOME_RELATIVE_DIR = ".omp/workflows";
export const WORKFLOW_PROJECTS_SUBDIR = "projects";

/** Test-only: override the machine home for path resolution (bun test isolation). */
let homedirOverride: string | undefined;
export function setHomedirForTests(dir: string | undefined): void {
  homedirOverride = dir;
}

export interface WorkflowProjectPaths {
  key: string;
  rootDir: string;
  runsDir: string;
  /** Project-scoped saved workflows: `<cwd>/.omp/workflows/saved` (committable). */
  projectSavedDir: string;
  /** Where project-scoped saved workflows used to be written; read-only compat. */
  homeSavedDir: string;
  settingsPath: string;
}

export function workflowHomeDir(): string {
  return join(homedirOverride ?? homedir(), WORKFLOW_HOME_RELATIVE_DIR);
}

export function workflowUserSavedDir(): string {
  return join(workflowHomeDir(), "saved");
}

export function workflowProjectKey(cwd: string): string {
  const projectPath = resolve(cwd);
  const slug = sanitizePathSegment(basename(projectPath) || "project");
  const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}

export function workflowProjectPaths(cwd: string): WorkflowProjectPaths {
  const key = workflowProjectKey(cwd);
  const rootDir = join(workflowHomeDir(), WORKFLOW_PROJECTS_SUBDIR, key);
  return {
    key,
    rootDir,
    runsDir: join(rootDir, "runs"),
    projectSavedDir: resolve(cwd, WORKFLOW_SAVED_DIR),
    homeSavedDir: join(rootDir, "saved"),
    settingsPath: join(rootDir, "settings.json"),
  };
}

function sanitizePathSegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return sanitized || "project";
}
