/**
 * RUNNER BRIDGE — read runner state, write runner control files
 * ==============================================================
 *
 * Architectural contract: ADR-RUNNER-BRIDGE-001 (alkindy/decisions/).
 *
 * Three-layer separation, files as the ONLY contract, zero direct coupling:
 *
 *  - The runner (repo nassaj-ops, scripts/runner) owns the state machine,
 *    the flock, quota gates, PID reconciliation. It NEVER imports or is called
 *    by nassaj-dev. Its only contact surface is JSON files under
 *    state/<project>/ and projects/registry.json.
 *  - This bridge is the ONLY process allowed to touch the runner's control
 *    files on behalf of the browser. It READS state files and WRITES control
 *    files — one direction only.
 *
 * The join key between the two repos is the filesystem PATH, never a shared
 * database: nassaj-dev resolves projectId -> absolute dir via
 * projectsDb.getProjectPathById(projectId); the bridge matches that dir against
 * the `dir` field of each runner projects/<name>.json to discover the runner
 * project name. No id is shared, no schema is shared, no socket is opened.
 *
 * Resilience contract (mirrors the project-board route): a missing or corrupt
 * runner file NEVER 500s — the read endpoint degrades to { registered: false }
 * or surfaces a per-file error flag.
 */

import path from 'path';
import os from 'os';
import { promises as fsPromises } from 'fs';

import { projectsDb } from '@/modules/database/index.js';

/**
 * Root of the runner install. Overridable for tests / relocated checkouts via
 * the NASSAJ_RUNNER_ROOT env var; defaults to the canonical nassaj-ops path.
 */
const RUNNER_ROOT =
  process.env.NASSAJ_RUNNER_ROOT ||
  path.join(os.homedir(), 'Project', 'nassaj-ops', 'scripts', 'runner');

const PROJECTS_DIR = () => path.join(RUNNER_ROOT, 'projects');
const STATE_DIR = () => path.join(RUNNER_ROOT, 'state');
const REGISTRY_FILE = () => path.join(PROJECTS_DIR(), 'registry.json');

// ---- file shapes (READ-ONLY mirrors of the runner's own schema) ----

type CycleState = {
  stage?: string;
  cycle?: number;
  status?: string;
  pid?: number;
  started_at?: string;
  fix_loops?: number;
  exit2_count?: number;
  interrupted_count?: number;
  last_error?: string;
  approval_notified?: boolean;
  dirty_notified?: boolean;
};

type ActivityState = {
  active_task_id?: string | null;
  active_phase_id?: string | null;
  stage?: string;
  started_at?: string;
  heartbeat_at?: string;
  log_file?: string;
  last_verdict?: 'clean' | 'unclean' | null;
};

type CritiqueVerdict = {
  clean?: boolean;
  notes?: string;
};

type RunnerProjectConfig = {
  name?: string;
  dir?: string;
  model?: string;
  threshold?: number;
  config_dir?: string;
  timeouts?: Record<string, number>;
  models?: Record<string, string>;
};

type RegistryEntry = { name: string; enabled: boolean; priority: number };
type Registry = { projects: RegistryEntry[] };

/** Canonicalize a path for stable comparison (trailing slash, dot segments). */
function canonical(p: string): string {
  return path.resolve(p).replace(/\/+$/, '');
}

async function readJsonOrNull<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fsPromises.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover the runner project NAME whose projects/<name>.json `dir` matches the
 * given absolute project path. Returns null when no runner project targets it
 * (board then degrades to "runner not configured"). Read-only.
 */
export async function findRunnerProjectName(projectPath: string): Promise<string | null> {
  const target = canonical(projectPath);
  let entries: string[];
  try {
    entries = await fsPromises.readdir(PROJECTS_DIR());
  } catch {
    return null; // runner not installed / no projects dir
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry === 'registry.json') {
      continue;
    }
    const cfg = await readJsonOrNull<RunnerProjectConfig>(path.join(PROJECTS_DIR(), entry));
    if (cfg?.dir && canonical(cfg.dir) === target) {
      return cfg.name || entry.replace(/\.json$/, '');
    }
  }
  return null;
}

export type RunnerStatus = {
  registered: boolean;
  /** runner project name (= join key for the WS watcher), null when unregistered */
  name: string | null;
  /** absolute project dir resolved from projectId */
  dir: string | null;
  enabled: boolean | null;
  priority: number | null;
  paused: boolean;
  /** primary state-machine state (cycle-state.json) */
  cycle: CycleState | null;
  /** optional liveness detail (activity.json) — null when the file is absent */
  activity: ActivityState | null;
  /** latest critique verdict (critique-verdict.json) */
  verdict: CritiqueVerdict | null;
  /** per-stage model map + timeouts surfaced from <name>.json (read-only) */
  config: { model: string | null; models: Record<string, string> | null; threshold: number | null } | null;
  /** true when a runner file existed but could not be parsed */
  stateError: boolean;
};

/** Path to the per-project state directory for a runner project name. */
function projectStateDir(name: string): string {
  return path.join(STATE_DIR(), name);
}

/** Control / state file paths for a runner project name. */
export function runnerPaths(name: string) {
  const dir = projectStateDir(name);
  return {
    stateDir: dir,
    cycleState: path.join(dir, 'cycle-state.json'),
    activity: path.join(dir, 'activity.json'),
    critiqueVerdict: path.join(dir, 'critique-verdict.json'),
    pause: path.join(dir, 'pause'),
    approveNextPhase: path.join(dir, 'approve-next-phase'),
  };
}

/**
 * Resolve projectId -> runner project name, returning null when the project is
 * not registered with the runner. Shared by every route below.
 */
export async function resolveRunnerProject(
  projectId: string,
): Promise<{ projectPath: string; name: string } | null> {
  const projectPath = projectsDb.getProjectPathById(projectId);
  if (!projectPath) {
    return null; // surfaced as 404 by the route
  }
  const name = await findRunnerProjectName(projectPath);
  if (!name) {
    return null; // registered:false — handled by the caller
  }
  return { projectPath, name };
}

/**
 * Build the single merged, resilience-wrapped status object the overlay renders.
 * Never throws on a missing/corrupt runner file.
 */
export async function readRunnerStatus(projectId: string): Promise<RunnerStatus> {
  const empty: RunnerStatus = {
    registered: false,
    name: null,
    dir: null,
    enabled: null,
    priority: null,
    paused: false,
    cycle: null,
    activity: null,
    verdict: null,
    config: null,
    stateError: false,
  };

  const projectPath = projectsDb.getProjectPathById(projectId);
  if (!projectPath) {
    return empty;
  }

  const name = await findRunnerProjectName(projectPath);
  if (!name) {
    return { ...empty, dir: canonical(projectPath) };
  }

  const paths = runnerPaths(name);
  const registry = await readJsonOrNull<Registry>(REGISTRY_FILE());
  const registryEntry = registry?.projects?.find((p) => p.name === name) ?? null;
  const config = await readJsonOrNull<RunnerProjectConfig>(
    path.join(PROJECTS_DIR(), `${name}.json`),
  );

  const cycle = await readJsonOrNull<CycleState>(paths.cycleState);
  const activity = await readJsonOrNull<ActivityState>(paths.activity);
  const verdict = await readJsonOrNull<CritiqueVerdict>(paths.critiqueVerdict);
  const paused = await fileExists(paths.pause);

  // stateError mirrors the board: a present-but-unreadable cycle-state.json.
  const cycleStateFilePresent = await fileExists(paths.cycleState);
  const stateError = cycleStateFilePresent && cycle === null;

  return {
    registered: true,
    name,
    dir: canonical(projectPath),
    enabled: registryEntry?.enabled ?? null,
    priority: registryEntry?.priority ?? null,
    paused,
    cycle,
    activity,
    verdict,
    config: config
      ? {
          model: config.model ?? null,
          models: config.models ?? null,
          threshold: config.threshold ?? null,
        }
      : null,
    stateError,
  };
}

// ---- CONTROL writes (atomic; one direction: bridge writes, runner reads) ----

/** Atomically merge the `enabled` field of the matched registry entry only. */
async function setRegistryEnabled(name: string, enabled: boolean): Promise<boolean> {
  const registry = await readJsonOrNull<Registry>(REGISTRY_FILE());
  if (!registry?.projects) {
    return false;
  }
  const entry = registry.projects.find((p) => p.name === name);
  if (!entry) {
    return false;
  }
  if (entry.enabled === enabled) {
    return true; // idempotent no-op
  }
  entry.enabled = enabled;
  await atomicWrite(REGISTRY_FILE(), `${JSON.stringify(registry, null, 2)}\n`);
  return true;
}

/** Write a file atomically via a temp file + rename (os.replace semantics). */
async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fsPromises.writeFile(tmp, contents, 'utf8');
  await fsPromises.rename(tmp, filePath);
}

/** touch: create an empty control file if absent (idempotent). */
async function touch(filePath: string, body?: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWrite(filePath, body ?? '');
}

/** start: enable runner for this project. Returns false when no registry entry. */
export async function startRunner(name: string): Promise<boolean> {
  return setRegistryEnabled(name, true);
}

/** stop: hard-disable the project in the registry. */
export async function stopRunner(name: string): Promise<boolean> {
  return setRegistryEnabled(name, false);
}

/** pause: create the pause control file (runner skips next launch). */
export async function pauseRunner(name: string, by?: string): Promise<void> {
  const body = JSON.stringify({ by: by ?? 'owner', at: new Date().toISOString() });
  await touch(runnerPaths(name).pause, body);
}

/** resume: remove the pause control file the bridge created. */
export async function resumeRunner(name: string): Promise<void> {
  await fsPromises.rm(runnerPaths(name).pause, { force: true });
}

/**
 * approve: create approve-next-phase. Caller MUST verify the current stage is
 * awaiting_approval first (409 otherwise) so a stale approval is not consumed
 * by a future awaiting_approval boundary.
 */
export async function approveNextPhase(name: string): Promise<void> {
  await touch(runnerPaths(name).approveNextPhase);
}

export { RUNNER_ROOT, STATE_DIR, PROJECTS_DIR, REGISTRY_FILE };
