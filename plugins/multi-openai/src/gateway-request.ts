import { createHash } from 'node:crypto';
import { mapEffort } from '../../multi-core/src/gateway/capabilities.ts';
import type { GatewayFetch } from '../../multi-core/src/gateway/fetch.ts';
import type {
  PreparedRequest,
  ProviderRequestInput,
} from '../../multi-core/src/gateway/provider-request.ts';
import { ProviderAuthError } from '../../multi-core/src/gateway/provider-request.ts';
import {
  type Effort,
  fromResponses,
  OPENAI_SIGNATURE_PREFIX,
  toResponses,
} from '../../multi-core/src/gateway/responses.ts';
import { estimateInputTokens } from '../../multi-core/src/gateway/tokens.ts';
import { originalToolNames } from '../../multi-core/src/gateway/tools.ts';
import { CodexAuthError, codexRequest } from './auth.ts';
import type { OpenAIModel } from './catalog.ts';
import { openaiInstructions } from './instructions.ts';

const OPENAI_URL = 'https://chatgpt.com/backend-api/codex/responses';
const MESSAGES_PATHS = ['/v1/messages', '/v1/messages/count_tokens'];

/** The prefixes of the reasoning signatures this provider writes into Claude's history. */
export const openaiSignaturePrefixes: readonly string[] = [OPENAI_SIGNATURE_PREFIX];

const openaiAuthHelp = ' Renew the Codex login.';

/** The effort names a Responses request can carry. */
const SENDABLE: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The model's own level nearest the one Claude asked for, so no turn fails over a level. */
function providerEffort(requested: Effort, available: readonly string[]): Effort {
  const mapped = mapEffort(requested, available);
  return SENDABLE.find((effort) => effort === mapped) ?? requested;
}

/** The Responses request for one Claude request to a native `multi/openai/` model. */
export function prepareOpenAIRequest(
  {
    method,
    pathname,
    body,
    session,
    fallbackSession,
    clientSession,
    agentId,
  }: ProviderRequestInput,
  externalModel: string,
  authFile: string,
  catalog: readonly OpenAIModel[],
): PreparedRequest {
  const model = catalog.find(({ slug }) => externalModel === `multi/openai/${slug}`);
  if (!model) {
    throw new Error('Unknown native OpenAI model');
  }
  if (!MESSAGES_PATHS.includes(pathname) || method !== 'POST') {
    throw new Error('External models require POST /v1/messages or /v1/messages/count_tokens');
  }
  const translated = toResponses(body, model.slug);
  const request = {
    ...translated,
    reasoning: {
      ...translated.reasoning,
      effort: providerEffort(translated.reasoning.effort, model.capabilities.efforts),
    },
    instructions: openaiInstructions(translated.instructions),
    prompt_cache_key: createHash('sha256')
      .update(
        JSON.stringify(['openai', session || fallbackSession, agentId ?? 'main', translated.model]),
      )
      .digest('hex'),
  };
  let estimate: number | undefined;
  const inputTokens = () => {
    estimate ??= estimateInputTokens(request);
    return estimate;
  };
  let toolNames: Map<string, string> | undefined;
  return {
    label: 'OpenAI',
    authHelp: openaiAuthHelp,
    endpoint: 'responses',
    route: 'openai',
    inputTokens,
    completion: { model: request.model, effort: request.reasoning.effort },
    requestEvent: (agent) => ({
      route: 'openai-request',
      agentId: agent,
      model: request.model,
      effort: request.reasoning.effort,
    }),
    failureEvent: (status) => ({ route: 'openai', status }),
    async send(signal: AbortSignal, fetchImpl: GatewayFetch) {
      toolNames = originalToolNames(body);
      const headers = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        originator: 'cc_multi_native',
        session_id: String(agentId ?? clientSession ?? fallbackSession),
      };
      try {
        return await codexRequest(authFile, signal, (auth) =>
          fetchImpl(OPENAI_URL, {
            method: 'POST',
            headers: { ...headers, ...auth },
            body: JSON.stringify(request),
            signal,
            redirect: 'error',
          }),
        );
      } catch (error) {
        throw error instanceof CodexAuthError ? new ProviderAuthError(error.message) : error;
      }
    },
    translate: (stream, emit, rememberWorkerModel) =>
      fromResponses(stream, externalModel, emit, {
        rememberWorkerModel,
        toolNames: toolNames ?? originalToolNames(body),
        stopSequences: body.stop_sequences,
        inputTokens: inputTokens(),
      }),
  };
}
