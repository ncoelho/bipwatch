import Anthropic from '@anthropic-ai/sdk';
import type { Claim } from '@bipwatch/data';
import type { ModelClient } from './model.ts';
import type { ClaimContext, Task } from './task.ts';
import { billedTokens, type BipContext, type InputDoc, type Outcome, type Usage } from './types.ts';
import type { ClaimValidator } from './validate.ts';

export interface DocResult {
  document_id: number;
  outcome: Outcome;
  attempts: number;
  claims: Claim[];
  rejected: { attempt: number; claim?: Partial<Claim>; errors: string[] }[];
  usage: Usage;
  model?: string;
}

export interface RunOptions<Out> {
  task: Task<Out>;
  docs: AsyncIterable<InputDoc> | Iterable<InputDoc>;
  model: ModelClient;
  bips: Map<number, BipContext>;
  validator: { validate: ClaimValidator; remember: (c: Claim) => void };
  today: string;
  /** Hard stop: no new document is started once this many tokens are used. */
  budgetTokens: number;
  /** Called after each document, in order. Persist here. */
  onDoc: (r: DocResult) => Promise<void>;
}

export interface RunSummary {
  docs_seen: number;
  claims_written: number;
  usage: Usage;
  stopped_by: 'done' | 'budget';
  /** Id of the last document fully processed. */
  last_document_id: number | null;
}

const add = (a: Usage, b: Usage): Usage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  cache_read_tokens: (a.cache_read_tokens ?? 0) + (b.cache_read_tokens ?? 0),
  cache_write_tokens: (a.cache_write_tokens ?? 0) + (b.cache_write_tokens ?? 0),
});
const total = billedTokens;

/**
 * Only failures that may pass on the next document are logged and skipped:
 * dropped connections, rate limits that outlast the SDK's own retries, and
 * server errors. Everything else (bad credentials, a bad request, a missing
 * model, or the SDK failing before it sends anything, which it does with a
 * plain Error when no credentials are configured) would fail on every
 * document, so it stops the run.
 */
function isFatal(err: unknown): boolean {
  const transient =
    err instanceof Anthropic.APIConnectionError ||
    err instanceof Anthropic.RateLimitError ||
    (err instanceof Anthropic.APIError && typeof err.status === 'number' && err.status >= 500);
  return !transient;
}

/**
 * Runs one task over documents (SPEC 6.2). Per document: one model call;
 * if any proposed claim fails validation, one retry that shows the model its
 * errors; then claims that still fail are dropped and logged.
 */
export async function runTask<Out>(opts: RunOptions<Out>): Promise<RunSummary> {
  const { task, model, bips, validator } = opts;
  const summary: RunSummary = {
    docs_seen: 0,
    claims_written: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    stopped_by: 'done',
    last_document_id: null,
  };

  for await (const doc of opts.docs) {
    if (total(summary.usage) >= opts.budgetTokens) {
      summary.stopped_by = 'budget';
      break;
    }
    const result = await processDoc(doc);
    summary.docs_seen++;
    summary.claims_written += result.claims.length;
    summary.usage = add(summary.usage, result.usage);
    summary.last_document_id = doc.id;
    await opts.onDoc(result);
  }
  return summary;

  async function processDoc(doc: InputDoc): Promise<DocResult> {
    const result: DocResult = {
      document_id: doc.id,
      outcome: 'none',
      attempts: 0,
      claims: [],
      rejected: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    if (doc.body_text.length > task.maxDocChars) {
      result.outcome = 'too_long';
      return result;
    }
    const docBips = doc.bips.map((n) => bips.get(n)).filter((b): b is BipContext => !!b);
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      { role: 'user', content: task.userMessage(doc, docBips) },
    ];

    for (let attempt = 1; attempt <= 2; attempt++) {
      result.attempts = attempt;
      let res;
      try {
        res = await model.run({
          model: task.model,
          effort: task.effort,
          system: task.context ? `${task.system}\n\n${task.context(docBips)}` : task.system,
          messages,
          schema: task.schema,
        });
      } catch (err) {
        if (isFatal(err)) throw err;
        result.outcome = 'error';
        result.rejected.push({ attempt, errors: [`model: ${(err as Error).message}`] });
        return result;
      }
      result.usage = add(result.usage, res.usage);
      result.model = res.model;
      if (res.stop === 'refusal') {
        result.outcome = 'refusal';
        return result;
      }
      if (!res.output) {
        result.outcome = 'error';
        result.rejected.push({ attempt, errors: [`model: output ${res.stop}`] });
        return result;
      }

      const ctx: ClaimContext = { bips, today: opts.today, modelId: res.model };
      const proposed = task.toClaims(res.output, doc, ctx);
      if (!proposed.length) {
        result.outcome = result.claims.length ? 'claims' : 'none';
        return result;
      }
      const failures: { claim: Claim; errors: string[] }[] = [];
      for (const claim of proposed) {
        const errors = validator.validate(claim, doc);
        if (errors.length) failures.push({ claim, errors });
        else {
          validator.remember(claim);
          result.claims.push(claim);
        }
      }
      for (const f of failures) result.rejected.push({ attempt, claim: f.claim, errors: f.errors });
      if (!failures.length || attempt === 2) {
        result.outcome = result.claims.length ? 'claims' : 'invalid';
        return result;
      }

      // One retry: show the model its own output and what was wrong with it.
      // Accepted claims are already kept; the retry may only add fixed ones.
      messages.push({ role: 'assistant', content: res.text });
      messages.push({
        role: 'user',
        content: [
          'Some of the items you returned failed validation:',
          ...failures.map(
            (f, i) => `${i + 1}. quote ${JSON.stringify(f.claim.source.quote)}: ${f.errors.join('; ')}`,
          ),
          '',
          'Return only corrected versions of those items (an empty list if you cannot fix them). Do not repeat items that passed.',
        ].join('\n'),
      });
    }
    return result;
  }
}
