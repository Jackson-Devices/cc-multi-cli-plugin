import { resolveExecutable } from '../../multi-core/src/gateway/executable.ts';
import { mergePermissions } from '../../multi-core/src/gateway/harness-settings.ts';
import type { ProviderAdapter } from '../../multi-core/src/gateway/provider-adapter.ts';
import { antigravityCapabilities } from './capabilities.ts';
import { AntigravityHarness } from './harness.ts';
import { ensureAntigravityHooks, installAntigravityHook } from './hooks.ts';
import {
  type AntigravityModel,
  antigravityDefaultWorkerModel,
  antigravityPickerOptions,
  discoverAntigravityModels,
} from './models.ts';
import { antigravityPermissionPolicy } from './permissions.ts';
import { ANTIGRAVITY_TOOLS } from './progress.ts';
import { antigravityUsageReader } from './usage-adapter.ts';

const adapter: ProviderAdapter = {
  async connect({ env, explicit, harnessSettings }) {
    let models: AntigravityModel[] = [];
    // The permission hook is global to the machine, so the provider is opt-in: the session's
    // plugin selection names it when its plugin is enabled (the installed command also sets
    // MULTI_ANTIGRAVITY=1 then), and a launch by hand sets MULTI_ANTIGRAVITY=1 itself.
    if (explicit || env.MULTI_ANTIGRAVITY === '1') {
      try {
        resolveExecutable('agy');
        models = await discoverAntigravityModels();
      } catch (error) {
        // A missing or signed-out agy removes Antigravity rows; it never blocks other providers.
        console.error(
          `Antigravity choices unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (!models.length) {
      return undefined;
    }
    // The hook points at this copy of the plugin; every launch makes it so.
    await installAntigravityHook();
    const harness = new AntigravityHarness(models, {
      checkPermissions: async (cwd, context) => {
        await ensureAntigravityHooks();
        return antigravityPermissionPolicy(mergePermissions(context, await harnessSettings(cwd)));
      },
    });
    // Each row's window and effort levels are what agy itself reports, not a list kept here.
    const capabilities = await antigravityCapabilities(models, { env });
    return {
      rows: () =>
        antigravityPickerOptions(models).map(({ model, label, id }) => ({
          model,
          label,
          description: 'Native Antigravity CLI',
          adjustableEffort: true,
          capabilities: capabilities.get(id),
        })),
      worker: { defaultId: antigravityDefaultWorkerModel },
      harness,
      displayTools: ANTIGRAVITY_TOOLS,
      usage: antigravityUsageReader(),
    };
  },
  commands: {
    '--antigravity-setup': {
      help: 'install the scoped native permission hook',
      async run() {
        await installAntigravityHook();
        console.log(
          'Antigravity native permission hook installed. Native login remains owned by agy.',
        );
      },
    },
    '--antigravity-models': {
      help: 'inspect the official Antigravity CLI catalog (native login required)',
      async run() {
        console.log(JSON.stringify(await discoverAntigravityModels(), null, 2));
      },
    },
  },
  environment: {
    MULTI_ANTIGRAVITY: '1 enables native Antigravity models and workers for a launch by hand',
  },
  account: {
    verb: 'login',
    run(args, { launcher }) {
      if (args.length) {
        throw new Error('Unsupported login arguments');
      }
      return launcher('--antigravity-setup');
    },
  },
};

export default adapter;
