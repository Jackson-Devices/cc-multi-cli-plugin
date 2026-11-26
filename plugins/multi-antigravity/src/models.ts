import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mapEffort } from '../../multi-core/src/gateway/capabilities.ts';
import {
  executableInvocation,
  resolveExecutable,
} from '../../multi-core/src/gateway/executable.ts';
import { nativeSpelling } from '../../multi-core/src/gateway/provider.ts';
import { antigravityEnvironment } from './cli.ts';

export interface AntigravityModel {
  id: string;
  model: string;
  label: string;
  effort?: 'low' | 'medium' | 'high';
}

function parseAntigravityModels(output: string): AntigravityModel[] {
  const models = new Map<string, AntigravityModel>();
  for (const line of output.split('\n')) {
    const match = /^([a-z0-9][a-z0-9.-]*)\t([^\t\r\n]+)\r?$/.exec(line);
    if (!match) {
      continue;
    }
    const [, id, label] = match;
    models.set(id, {
      id,
      model: `multi/antigravity/${id}`,
      label: `Antigravity · ${label}`,
    });
  }
  if (!models.size) {
    throw new Error('Antigravity returned no recognized model catalog; run agy models.');
  }
  return [...models.values()];
}

export interface AntigravityModelDiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  executable?: string;
  execFile?: typeof execFile;
  exists?: (filename: string) => boolean;
}

export async function discoverAntigravityModels(
  options: AntigravityModelDiscoveryOptions = {},
): Promise<AntigravityModel[]> {
  const platform = options.platform ?? process.platform;
  const environment = antigravityEnvironment({ ...options.env, NO_COLOR: '1' });
  const invocation = executableInvocation(
    resolveExecutable('agy', {
      platform,
      env: environment,
      configuredPath: options.executable,
      exists: options.exists,
    }),
    ['models'],
    platform,
    environment,
  );
  const { stdout } = await promisify(options.execFile ?? execFile)(
    invocation.command,
    invocation.args,
    {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      env: environment,
      ...invocation.options,
    },
  );
  return parseAntigravityModels(stdout);
}

/**
 * `agy models` also lists an `xhigh` variant for some models. Claude Code offers `xhigh` only
 * on profiles that would change how it treats the row, so `/effort` cannot reach it: the
 * variant keeps its own `/model` row and always runs at the effort its ID names.
 */
const PINNED_EFFORT = /-xhigh$/;

/** Group only suffix variants with no independently advertised base identity. */
export function antigravityPickerOptions(models: readonly AntigravityModel[]): AntigravityModel[] {
  const nativeIds = new Set(models.map(({ id }) => id));
  const rows = new Map<string, AntigravityModel>();
  for (const option of models) {
    const base = option.id.replace(/-(low|medium|high)$/, '');
    if (base === option.id || nativeIds.has(base)) {
      rows.set(option.id, option);
    } else if (!rows.has(base)) {
      rows.set(base, {
        id: base,
        model: `multi/antigravity/${base}`,
        label: option.label.replace(/(?:\s*[-·]\s*|\s+|\s*\()(low|medium|high)\)?$/i, ''),
      });
    }
  }
  return [...rows.values()];
}

/**
 * The model a `Antigravity` worker runs when the Agent call names none: the newest
 * Gemini generation, a Pro model before a Flash of the same version. `agy models` marks no
 * default and lists in its own order, so the version decides.
 */
export function antigravityDefaultWorkerModel(ids: readonly string[]): string | undefined {
  let best: { id: string; rank: number[] } | undefined;
  for (const id of ids) {
    const match = /^gemini-(\d+)(?:\.(\d+))?(?:-|$)/.exec(id);
    // A pinned effort row (`<base>-xhigh` beside `<base>`) is never the default.
    if (!match || (PINNED_EFFORT.test(id) && ids.includes(id.replace(PINNED_EFFORT, '')))) {
      continue;
    }
    // Pro before Flash, Flash before Flash-Lite; equal ranks fall to the greater id so the
    // pick never depends on the order `agy models` lists.
    const rank = [Number(match[1]), Number(match[2] ?? 0), modelTier(id)];
    const order = best ? compareRank(rank, best.rank) : 1;
    if (!best || order > 0 || (order === 0 && id > best.id)) {
      best = { id, rank };
    }
  }
  return best?.id;
}

function modelTier(id: string): number {
  if (id.includes('-pro')) {
    return 2;
  }
  return id.includes('-lite') ? 0 : 1;
}

function compareRank(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function defaultVariant(models: readonly AntigravityModel[], base: string) {
  for (const effort of ['medium', 'high', 'low']) {
    const variant = models.find(({ id }) => id === `${base}-${effort}`);
    if (variant) {
      return variant;
    }
  }
  throw new Error('Antigravity base route has no advertised native variant.');
}

/** Resolve advertised variants; let agy validate effort for models without suffixes. */
export function selectAntigravityModel(
  models: readonly AntigravityModel[],
  model: string | undefined,
  effort?: unknown,
): AntigravityModel {
  const requested = nativeSpelling(model);
  const native = models.find((option) => option.model === requested);
  const row =
    native ?? antigravityPickerOptions(models).find((option) => option.model === requested);
  if (!row) {
    throw new Error('Unknown Antigravity model; run agy models for native selections.');
  }
  const selected = native ?? defaultVariant(models, row.id);
  if (effort === undefined || PINNED_EFFORT.test(selected.id)) {
    return selected;
  }
  if (typeof effort !== 'string') {
    throw new Error('Antigravity effort must be a named level.');
  }
  const base = selected.id.replace(/-(low|medium|high)$/, '');
  if (base === selected.id) {
    // No advertised variant: agy takes the level as a flag and validates it itself.
    const mapped = mapEffort(effort, FLAG_EFFORTS);
    return { ...selected, effort: FLAG_EFFORTS.find((level) => level === mapped) };
  }
  // Claude offers levels a model may not advertise (GPT-OSS 120B lists only medium, and
  // Claude's own scale runs to max). The nearest advertised variant runs rather than the
  // turn being refused: Claude's session effort is High by default, and compaction asks too.
  const mapped = mapEffort(effort, advertisedEfforts(models, base));
  return models.find((option) => option.id === `${base}-${mapped}`) ?? selected;
}

/** The levels the `--effort` flag carried before variants were mapped; agy validates them. */
const FLAG_EFFORTS = ['low', 'medium', 'high'] as const;

const VARIANT_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

/** The effort variants `agy models` advertises for a base model, weakest first. */
export function advertisedEfforts(models: readonly AntigravityModel[], base: string): string[] {
  return VARIANT_EFFORTS.filter((effort) => models.some(({ id }) => id === `${base}-${effort}`));
}

/**
 * The native model a picker row stands for when no effort is asked: the row's own ID when
 * `agy models` lists it, else the default variant of the base it groups.
 */
export function rowModel(models: readonly AntigravityModel[], rowId: string): string {
  return models.some(({ id }) => id === rowId) ? rowId : defaultVariant(models, rowId).id;
}

/** Whether a row is an effort pinned beside its own base row, such as `<base>-xhigh`. */
export function pinnedRow(models: readonly AntigravityModel[], rowId: string): boolean {
  const base = rowId.replace(PINNED_EFFORT, '');
  return base !== rowId && advertisedEfforts(models, base).some((effort) => effort !== 'xhigh');
}
