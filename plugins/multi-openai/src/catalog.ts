import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ModelCapabilities } from '../../multi-core/src/gateway/capabilities.ts';
import { isRecord } from '../../multi-core/src/gateway/record.ts';
import { MODELS } from './models.ts';

/** One model the OpenAI subscription offers, with what Codex reports it can do. */
export interface OpenAIModel {
  slug: string;
  capabilities: ModelCapabilities;
}

/** The efforts every curated model took when the list was written by hand. */
const DECLARED_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The curated rows with no measured facts, used when Codex's catalog cannot be read. */
function declaredCatalog(reason: string): OpenAIModel[] {
  return Object.values(MODELS).map((slug) => ({
    slug,
    capabilities: { efforts: DECLARED_EFFORTS, source: 'declared', evidence: reason },
  }));
}

function effortsOf(levels: unknown): string[] {
  if (!Array.isArray(levels)) {
    return [];
  }
  return levels.flatMap((level) => {
    const effort = isRecord(level) ? level.effort : level;
    return typeof effort === 'string' ? [effort] : [];
  });
}

function catalogModel(entry: unknown, evidence: string): OpenAIModel | undefined {
  // A hidden model is one Codex keeps for its own use, such as its reviewer.
  if (!isRecord(entry) || typeof entry.slug !== 'string' || entry.visibility !== 'list') {
    return undefined;
  }
  // `context_window` is only where the Codex app starts a session (272,000 or 500,000);
  // `max_context_window` is what the provider accepts. Measured 2026-11-27: one request of
  // 838,527 input tokens to gpt-6.2-sol and one of 438,862 to gpt-6.2-astra both answered.
  const ceiling = entry.max_context_window;
  const window = typeof ceiling === 'number' && ceiling > 0 ? ceiling : entry.context_window;
  return {
    slug: entry.slug,
    capabilities: {
      window: typeof window === 'number' && window > 0 ? window : undefined,
      efforts: effortsOf(entry.supported_reasoning_levels),
      source: 'measured',
      evidence,
    },
  };
}

/**
 * The models Codex lists for this account, from the catalog Codex itself fetches and caches
 * beside its login. Multi makes no catalog request of its own: the cache is what the signed-in
 * Codex was last told, and its fetch date is carried into the report. Without a readable
 * cache the curated rows are offered as declared, with no window claimed.
 */
export async function openaiCatalog(codexHome: string): Promise<OpenAIModel[]> {
  let cache: unknown;
  try {
    cache = JSON.parse(await readFile(path.join(codexHome, 'models_cache.json'), 'utf8'));
  } catch {
    return declaredCatalog('Codex models_cache.json is missing or unreadable');
  }
  if (!isRecord(cache) || !Array.isArray(cache.models)) {
    return declaredCatalog('Codex models_cache.json has no model list');
  }
  const fetched = typeof cache.fetched_at === 'string' ? cache.fetched_at.slice(0, 10) : 'unknown';
  const evidence = `Codex models_cache.json, fetched ${fetched}`;
  const models = cache.models.flatMap((entry) => catalogModel(entry, evidence) ?? []);
  return models.length ? models : declaredCatalog('Codex models_cache.json lists no model');
}

/** The default rows: the curated models the catalog still lists, in curated order. */
export function curatedModels(catalog: readonly OpenAIModel[]): OpenAIModel[] {
  return Object.values(MODELS).flatMap(
    (slug) => catalog.find((model) => model.slug === slug) ?? [],
  );
}
