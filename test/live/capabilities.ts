// Live check of the capability probes: what the signed-in Codex catalog and the installed
// `agy` report per model, and the Claude Code profile chosen from it. No prompt is sent to
// any model, so the check costs nothing.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { antigravityCapabilities } from '../../plugins/multi-antigravity/src/capabilities.ts';
import { discoverAntigravityModels } from '../../plugins/multi-antigravity/src/models.ts';
import { selectProfile } from '../../plugins/multi-core/src/gateway/capabilities.ts';
import { loadProviders } from '../../plugins/multi-core/src/gateway/provider-adapter.ts';
import { closeHarnesses, connectProviders } from '../../plugins/multi-core/src/launch/providers.ts';

const PROBED = ['openai', 'antigravity'];
const MILLION = 1_000_000;
const LONG_CONTEXT_FLOOR = 800_000;

/** Every row of the connected providers: measured, untagged, and never sized up. */
async function checkRows(): Promise<number> {
  const loaded = await loadProviders();
  const selection = PROBED.filter((name) => loaded.some(({ manifest }) => manifest.name === name));
  const providers = await connectProviders(loaded, { args: [] }, selection);
  let checked = 0;
  try {
    for (const [name, provider] of Object.entries(providers)) {
      const rows = provider.rows(true);
      if (!rows.length) {
        console.log(`${name}: not signed in, skipped`);
        continue;
      }
      assert(
        rows.some(({ capabilities }) => capabilities?.source === 'measured' && capabilities.window),
        `${name} reported no measured window for any model`,
      );
      for (const row of rows) {
        // Claude Code hides a tagged row on a subscription whose extra usage is off.
        assert(!row.model.includes('[1m]'), `${row.model} carries a context tag`);
        const choice = selectProfile(row.capabilities, row.adjustableEffort, true);
        // A row may be sized 1M only when its measured window is within reach of a million.
        assert(
          choice.window < MILLION || (row.capabilities?.window ?? 0) >= LONG_CONTEXT_FLOOR,
          `${row.model} is sized ${choice.window} far above its measured window`,
        );
        checked++;
      }
      console.log(`${name}: ${rows.length} rows checked`);
    }
  } finally {
    await closeHarnesses(providers);
  }
  return checked;
}

/** A probe that reads no cache: every row must come back measured from `agy` itself. */
async function checkFreshAntigravityProbe() {
  let models: Awaited<ReturnType<typeof discoverAntigravityModels>>;
  try {
    models = await discoverAntigravityModels();
  } catch {
    console.log('antigravity: agy is missing or signed out, fresh probe skipped');
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'multi-capabilities-'));
  try {
    const started = Date.now();
    const rows = await antigravityCapabilities(models, {
      cacheFile: path.join(directory, 'capabilities.json'),
    });
    for (const [id, capabilities] of rows) {
      assert.equal(capabilities.source, 'measured', `agy reported no window for ${id}`);
    }
    console.log(`antigravity: fresh probe of ${rows.size} rows took ${Date.now() - started} ms`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const checked = await checkRows();
assert(checked > 0, 'no probed provider is signed in');
await checkFreshAntigravityProbe();
console.log('capabilities: ok');
