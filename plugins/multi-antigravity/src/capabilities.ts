// What each Antigravity model can do, read from `agy` itself. `agy models` lists only IDs
// and labels, so the window and thinking levels come from the Agent Client Protocol server:
// selecting a model there reports both, and no prompt is sent, so nothing is billed.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import type { ModelCapabilities } from '../../multi-core/src/gateway/capabilities.ts';
import {
  executableInvocation,
  resolveExecutable,
} from '../../multi-core/src/gateway/executable.ts';
import { isRecord } from '../../multi-core/src/gateway/record.ts';
import { antigravityEnvironment } from './cli.ts';
import { antigravitySettingsFile } from './hooks.ts';
import {
  type AntigravityModel,
  advertisedEfforts,
  antigravityPickerOptions,
  pinnedRow,
  rowModel,
} from './models.ts';

/** What agy reported for one native model. */
interface ModelFacts {
  window?: number;
  efforts?: string[];
  /** The window was read from agy's silence, with no model of another size to confirm it. */
  inferred?: boolean;
}

interface Probe {
  at: number;
  facts: Record<string, ModelFacts>;
}

const REPLY_MS = 15_000;
/** agy reports a size within 50 ms of a model change; silence this long means no change. */
const SILENCE_MS = 400;
const PROBE_MS = 45_000;
/** A window is an account fact agy can change without changing a model ID. */
const CACHE_MS = 24 * 60 * 60 * 1000;

/** One ACP session over stdio: requests in, and the session updates agy volunteers. */
class AcpSession {
  /** The window agy last reported, and how many times it has reported one. */
  size: number | undefined;
  reports = 0;
  /** The thinking levels of the model last selected; undefined until agy states them. */
  efforts: string[] | undefined;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiting = new Map<number, (message: Record<string, unknown>) => void>();
  private nextId = 1;
  private sessionId = '';

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    createInterface({ input: child.stdout }).on('line', (line) => this.receive(line));
    // A probe that cannot start is reported by the request that times out.
    child.on('error', () => {});
  }

  private receive(line: string) {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message)) {
      return;
    }
    if (typeof message.id === 'number' && this.waiting.has(message.id)) {
      this.waiting.get(message.id)?.(message);
      this.waiting.delete(message.id);
    } else if (isRecord(message.params) && isRecord(message.params.update)) {
      this.observe(message.params.update);
    }
  }

  private observe(update: Record<string, unknown>) {
    if (update.sessionUpdate === 'usage_update' && typeof update.size === 'number') {
      this.size = update.size;
      this.reports++;
    } else if (update.sessionUpdate === 'config_option_update') {
      this.efforts = thinkingLevels(update.configOptions);
    }
  }

  private async request(method: string, params: Record<string, unknown>) {
    const id = this.nextId++;
    const reply = new Promise<Record<string, unknown>>((resolve) => this.waiting.set(id, resolve));
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const message = await Promise.race([reply, delay(REPLY_MS, undefined, { ref: false })]);
    if (!message || !isRecord(message.result)) {
      throw new Error(`agy acp did not answer ${method}`);
    }
    return message.result;
  }

  /** Wait until agy reports a window after `before` reports, or stays silent. */
  private async settled(before: number) {
    for (let waited = 0; waited < SILENCE_MS && this.reports === before; waited += 25) {
      await delay(25);
    }
  }

  /** Start a session; returns the model it opens on. */
  async open(cwd: string): Promise<string | undefined> {
    await this.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const session = await this.request('session/new', { cwd, mcpServers: [] });
    this.sessionId = typeof session.sessionId === 'string' ? session.sessionId : '';
    await this.settled(0);
    return isRecord(session.models) && typeof session.models.currentModelId === 'string'
      ? session.models.currentModelId
      : undefined;
  }

  /** Select a model; `window` is undefined when agy reported no size for the change. */
  async select(modelId: string): Promise<ModelFacts> {
    const before = this.reports;
    this.efforts = undefined;
    await this.request('session/set_model', { sessionId: this.sessionId, modelId });
    await this.settled(before);
    return { window: this.reports > before ? this.size : undefined, efforts: this.efforts };
  }

  close() {
    this.child.kill();
  }
}

function thinkingLevels(options: unknown): string[] {
  const levels = Array.isArray(options)
    ? options.find((option) => isRecord(option) && option.id === 'thought_level')
    : undefined;
  if (!isRecord(levels) || !Array.isArray(levels.options)) {
    return [];
  }
  return levels.options.flatMap((option) =>
    isRecord(option) && typeof option.value === 'string' ? [option.value] : [],
  );
}

/** A model already measured whose window is the least common, to step through. */
function contrast(known: ReadonlyMap<string, number>, differentFrom?: number): string | undefined {
  const counts = new Map<number, number>();
  for (const size of known.values()) {
    counts.set(size, (counts.get(size) ?? 0) + 1);
  }
  let best: string | undefined;
  for (const [id, size] of known) {
    const rarer =
      best === undefined || (counts.get(size) ?? 0) < (counts.get(known.get(best) ?? 0) ?? 0);
    if (size !== differentFrom && rarer) {
      best = id;
    }
  }
  return best;
}

/**
 * Measure one model. agy reports a window only when it changes, so the session first steps
 * onto a model of another size; a change that is still silent is confirmed from a second
 * size. With no other size yet measured, silence after an answered change is read as "the
 * same window as before", which is what agy's own display would show.
 */
async function measure(
  session: AcpSession,
  known: Map<string, number>,
  target: string,
): Promise<ModelFacts> {
  const away = contrast(known);
  if (away !== undefined && known.get(away) !== session.size) {
    await session.select(away);
  }
  const first = await session.select(target);
  if (first.window !== undefined) {
    return first;
  }
  const other = contrast(known, session.size);
  if (other === undefined) {
    return { window: session.size, efforts: first.efforts, inferred: true };
  }
  await session.select(other);
  const again = await session.select(target);
  return { window: again.window, efforts: first.efforts ?? again.efforts };
}

async function probeModels(session: AcpSession, targets: readonly string[], facts: Probe['facts']) {
  const opened = await session.open(os.tmpdir());
  const known = new Map<string, number>();
  if (opened !== undefined && session.size !== undefined) {
    known.set(opened, session.size);
  }
  for (const target of targets) {
    const found = await measure(session, known, target);
    facts[target] = found;
    if (found.window !== undefined) {
      known.set(target, found.window);
    }
  }
  // A window read from silence is measured again once a model of another size is known.
  for (const target of targets.filter((id) => facts[id]?.inferred)) {
    const again = await measure(session, known, target);
    if (again.window !== undefined && !again.inferred) {
      facts[target] = { ...again, efforts: again.efforts ?? facts[target]?.efforts };
      known.set(target, again.window);
    }
  }
}

interface ProbeOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Where the last probe is kept; a path that does not exist forces a fresh probe. */
  cacheFile?: string;
}

/** Ask agy for each model's window and thinking levels. A failure leaves facts unmeasured. */
async function probe(targets: readonly string[], options: ProbeOptions): Promise<Probe> {
  const platform = options.platform ?? process.platform;
  const env = antigravityEnvironment({ ...options.env, NO_COLOR: '1' });
  const facts: Probe['facts'] = {};
  let session: AcpSession | undefined;
  try {
    const invocation = executableInvocation(
      resolveExecutable('agy', { platform, env }),
      ['acp'],
      platform,
      env,
    );
    session = new AcpSession(
      spawn(invocation.command, invocation.args, { env, stdio: 'pipe', ...invocation.options }),
    );
    // What was measured before a failure or the time limit is kept; the rest stays unmeasured.
    await Promise.race([
      probeModels(session, targets, facts),
      delay(PROBE_MS, undefined, { ref: false }),
    ]);
  } catch (error) {
    console.error(
      `Antigravity capabilities not measured: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    session?.close();
  }
  return { at: Date.now(), facts };
}

function defaultCacheFile(): string {
  return path.join(
    path.dirname(antigravitySettingsFile({ homedir: os.homedir() })),
    'multi-capabilities.json',
  );
}

async function cached(file: string, targets: readonly string[]): Promise<Probe | undefined> {
  try {
    const saved: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isRecord(saved) || typeof saved.at !== 'number' || !isRecord(saved.facts)) {
      return undefined;
    }
    const facts = saved.facts as Probe['facts'];
    const complete = targets.every((target) => typeof facts[target]?.window === 'number');
    return complete && Date.now() - saved.at < CACHE_MS ? { at: saved.at, facts } : undefined;
  } catch {
    return undefined;
  }
}

async function remember(file: string, result: Probe, targets: readonly string[]) {
  // Only a whole answer is kept, so a partial probe is tried again at the next launch.
  if (!targets.every((target) => result.facts[target]?.window !== undefined)) {
    return;
  }
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(result), { mode: 0o600 });
  } catch {
    /* The cache only saves a probe; a launch never depends on it. */
  }
}

function rowCapabilities(
  models: readonly AntigravityModel[],
  rowId: string,
  result: Probe,
): ModelCapabilities {
  const found = result.facts[rowModel(models, rowId)] ?? {};
  const base = rowId.replace(/-xhigh$/, '');
  const advertised = found.efforts?.length ? found.efforts : advertisedEfforts(models, base);
  const measured = found.window !== undefined;
  return {
    window: found.window,
    // A pinned row always runs at the effort its ID names.
    efforts: pinnedRow(models, rowId) ? [] : advertised,
    source: measured ? 'measured' : 'declared',
    evidence: measured
      ? `agy acp, read ${new Date(result.at).toISOString().slice(0, 10)}`
      : 'agy reported no window for this model',
  };
}

/**
 * Capabilities for every picker row, by row ID. The probe is one `agy acp` session of a few
 * seconds and its answer is kept for a day, so most launches read a file instead.
 */
export async function antigravityCapabilities(
  models: readonly AntigravityModel[],
  options: ProbeOptions = {},
): Promise<Map<string, ModelCapabilities>> {
  const rows = antigravityPickerOptions(models).map(({ id }) => id);
  const targets = [...new Set(rows.map((id) => rowModel(models, id)))];
  const file = options.cacheFile ?? defaultCacheFile();
  let result = await cached(file, targets);
  if (!result) {
    result = await probe(targets, options);
    await remember(file, result, targets);
  }
  const answer = result;
  return new Map(rows.map((id) => [id, rowCapabilities(models, id, answer)]));
}
