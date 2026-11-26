// What a provider's model can do, and the Claude Code profile that fits it. A provider probes
// its own models; this file only chooses, so it names no provider.

/** What a provider says one model can do. */
export interface ModelCapabilities {
  /** Input tokens the provider accepts for this model; undefined when not established. */
  window?: number;
  /** Effort levels the provider accepts, weakest first; empty when effort is fixed. */
  efforts: readonly string[];
  /**
   * `measured`: read from the provider this launch or from its own cache. `declared`: a value
   * written in Multi's source because the provider reports none.
   */
  source: 'measured' | 'declared';
  /** One line naming where the facts came from, shown in the report. */
  evidence: string;
}

/** The Claude Code profile chosen for one row, and what it cost. */
export interface ProfileChoice {
  behavesAs: string;
  /** The window Claude Code will size the session to. */
  window: number;
  /** Claude Code effort level to provider effort level, for every level the profile offers. */
  effortMap: Readonly<Record<string, string>>;
  /** One sentence per loss, such as a real window larger than the one sized. */
  clamped: readonly string[];
}

interface ClaudeProfile {
  id: string;
  window: number;
  efforts: readonly string[];
}

/**
 * The Claude Code profiles a row may borrow through `behavesAs`, checked against Claude Code
 * 2.1.332. A picker row has no window field of its own, so these two windows are the only
 * ones a row can state. The 1M profile is native: it needs no `[1m]` suffix on the model ID,
 * and Claude Code hides a suffixed row on a subscription whose extra usage is off.
 */
const FIXED_EFFORT: ClaudeProfile = { id: 'claude-haiku-4-5', window: 200_000, efforts: [] };
const STANDARD: ClaudeProfile = {
  id: 'claude-sonnet-4-6',
  window: 200_000,
  efforts: ['low', 'medium', 'high'],
};
const LONG_CONTEXT: ClaudeProfile = {
  id: 'claude-sonnet-5',
  window: 1_000_000,
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
};

/** Every effort name a provider or Claude Code uses, weakest first. */
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const MIDDLE = EFFORT_ORDER.indexOf('medium');

function rank(effort: string): number {
  return EFFORT_ORDER.indexOf(effort);
}

/**
 * The provider's level for a requested one: the same level when the provider has it, else
 * the nearest, and the weaker of two equally near. A turn is never refused over an effort a
 * provider can approximate. Undefined only when the provider has no levels at all.
 */
export function mapEffort(requested: string, available: readonly string[]): string | undefined {
  if (available.includes(requested)) {
    return requested;
  }
  const known = available.filter((effort) => rank(effort) >= 0);
  if (!known.length) {
    return available[0];
  }
  const wanted = rank(requested) >= 0 ? rank(requested) : MIDDLE;
  let best = known[0];
  for (const effort of known) {
    const distance = Math.abs(rank(effort) - wanted);
    const bestDistance = Math.abs(rank(best) - wanted);
    if (distance < bestDistance || (distance === bestDistance && rank(effort) < rank(best))) {
      best = effort;
    }
  }
  return best;
}

function count(tokens: number): string {
  return tokens.toLocaleString('en-US');
}

function windowLosses(window: number | undefined, sized: number): string[] {
  if (window === undefined) {
    return [`window not established; sized ${count(sized)}`];
  }
  // A few percent over the largest profile is not a loss worth a line.
  if (window > sized * 1.1) {
    return [`real window ${count(window)}; sized ${count(sized)}`];
  }
  if (window < sized) {
    return [`real window ${count(window)} is below the ${count(sized)} sized`];
  }
  return [];
}

function effortLosses(
  profile: ClaudeProfile,
  available: readonly string[],
  effortMap: Readonly<Record<string, string>>,
): string[] {
  if (!available.length) {
    return profile.efforts.length ? ['effort is fixed; /effort has no effect'] : [];
  }
  const losses: string[] = [];
  const reached = new Set(Object.values(effortMap));
  for (const target of reached) {
    const sources = profile.efforts.filter((effort) => effortMap[effort] === target);
    if (sources.length > 1) {
      losses.push(`${sources.join(', ')} all run as ${target}`);
    }
  }
  const unreached = available.filter((effort) => !reached.has(effort));
  if (unreached.length) {
    losses.push(`not reachable from /effort: ${unreached.join(', ')}`);
  }
  return losses;
}

/**
 * `MULTI_DISABLE_1M_CONTEXT` keeps every row at the 200K sizing. An explicit negative reads
 * as off, not as "the variable is present".
 */
function longContextAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.MULTI_DISABLE_1M_CONTEXT;
  return value === undefined || ['', '0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

/**
 * Choose the profile for a row. A row with no capabilities gets what every row got before
 * capabilities existed. A window is never rounded up: only a model that takes a million
 * tokens is sized to a million.
 */
export function selectProfile(
  capabilities: ModelCapabilities | undefined,
  adjustableEffort: boolean,
  longContext = longContextAllowed(),
): ProfileChoice {
  const narrow = adjustableEffort ? STANDARD : FIXED_EFFORT;
  if (!capabilities) {
    return {
      behavesAs: narrow.id,
      window: narrow.window,
      effortMap: Object.fromEntries(narrow.efforts.map((effort) => [effort, effort])),
      clamped: [],
    };
  }
  const fits = longContext && (capabilities.window ?? 0) >= LONG_CONTEXT.window;
  const profile = fits ? LONG_CONTEXT : narrow;
  const effortMap: Record<string, string> = {};
  for (const effort of profile.efforts) {
    const mapped = mapEffort(effort, capabilities.efforts);
    if (mapped !== undefined) {
      effortMap[effort] = mapped;
    }
  }
  return {
    behavesAs: profile.id,
    window: profile.window,
    effortMap,
    clamped: [
      ...windowLosses(capabilities.window, profile.window),
      ...effortLosses(profile, capabilities.efforts, effortMap),
    ],
  };
}

/** One row of the report: a picker row and the provider that offers it. */
interface ReportRow {
  provider: string;
  model: string;
  adjustableEffort: boolean;
  capabilities?: ModelCapabilities;
}

function reportLines(row: ReportRow): string[] {
  const choice = selectProfile(row.capabilities, row.adjustableEffort);
  const found = row.capabilities;
  const window = found?.window === undefined ? 'unknown' : count(found.window);
  const efforts = Object.entries(choice.effortMap)
    .map(([from, to]) => (from === to ? from : `${from}->${to}`))
    .join(' ');
  return [
    `${row.model}`,
    `  found: window ${window}, efforts ${found?.efforts.join(' ') || 'none'} (${
      found ? `${found.source}: ${found.evidence}` : 'no capabilities reported'
    })`,
    `  chosen: ${choice.behavesAs}, sized ${count(choice.window)}, effort ${efforts || 'fixed'}`,
    ...choice.clamped.map((loss) => `  lost: ${loss}`),
  ];
}

/** What each provider reported for each model, the profile chosen, and what that cost. */
export function capabilityReport(rows: readonly ReportRow[]): string {
  if (!rows.length) {
    return 'No connected provider offers a model.';
  }
  const lines: string[] = [];
  let provider: string | undefined;
  for (const row of rows) {
    if (row.provider !== provider) {
      provider = row.provider;
      lines.push(`== ${provider}`);
    }
    lines.push(...reportLines(row));
  }
  return lines.join('\n');
}
