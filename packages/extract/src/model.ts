import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import type { Usage } from './types.ts';

export interface ModelRequest<Out> {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  schema: z.ZodType<Out>;
}

export interface ModelResult<Out> {
  /** Parsed output, or null when the model refused or the output did not parse. */
  output: Out | null;
  stop: 'ok' | 'refusal' | 'max_tokens' | 'unparsed';
  /** The JSON text the model returned, replayed on a retry. */
  text: string;
  usage: Usage;
  /** The model that answered (differs from the request after a fallback). */
  model: string;
}

/** The only thing the runner needs from a model. Tests pass a fake. */
export interface ModelClient {
  run<Out>(req: ModelRequest<Out>): Promise<ModelResult<Out>>;
}

/**
 * Claude API client: structured output against the task's zod schema, the
 * system prompt cached across documents, and server-side refusal fallback so
 * a classifier false positive on security discussion retries on another model
 * instead of losing the document.
 */
export function claudeClient(client = new Anthropic()): ModelClient {
  return {
    async run<Out>(req: ModelRequest<Out>): Promise<ModelResult<Out>> {
      const response = await client.beta.messages.parse({
        model: req.model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: req.messages,
        output_config: { format: betaZodOutputFormat(req.schema), effort: req.effort },
      });

      const u = response.usage;
      const usage: Usage = {
        input_tokens:
          (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        output_tokens: u.output_tokens ?? 0,
      };
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');

      if (response.stop_reason === 'refusal') return { output: null, stop: 'refusal', text, usage, model: response.model };
      if (response.stop_reason === 'max_tokens') return { output: null, stop: 'max_tokens', text, usage, model: response.model };
      const output = (response.parsed_output ?? null) as Out | null;
      return { output, stop: output ? 'ok' : 'unparsed', text, usage, model: response.model };
    },
  };
}
