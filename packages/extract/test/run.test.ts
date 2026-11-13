import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { runTask, type DocResult } from '../src/run.ts';
import { billedTokens } from '../src/types.ts';
import { stanceTask } from '../src/tasks/stance/index.ts';
import { makeValidator } from '../src/validate.ts';
import { bips, doc, scriptedModel } from './helpers.ts';

const ok = (quote: string, over = {}) => ({
  bip: 352,
  stance: 'concept-ack',
  condition: null,
  statement: 'The author supports silent payments.',
  quote,
  ...over,
});

async function run(docs: ReturnType<typeof doc>[], script: Parameters<typeof scriptedModel>[0], budget = 1e9) {
  const { client, calls } = scriptedModel(script);
  const results: DocResult[] = [];
  const summary = await runTask({
    task: stanceTask,
    docs,
    model: client,
    bips,
    validator: makeValidator([]),
    today: '2026-11-06',
    budgetTokens: budget,
    onDoc: async (r) => void results.push(r),
  });
  return { summary, results, calls };
}

describe('runTask', () => {
  it('logs none, claims and invalid outcomes per document', async () => {
    const { summary, results } = await run(
      [doc(1, 'Just a question about scanning.'), doc(2, 'Concept ACK.'), doc(3, 'I like it.')],
      { 2: [ok('Concept ACK.')], 3: [ok('I love it.')] },
    );
    expect(results.map((r) => r.outcome)).toEqual(['none', 'claims', 'invalid']);
    expect(results[2].attempts).toBe(2);
    expect(results[2].rejected[0].errors[0]).toMatch(/^quote:/);
    expect(summary).toMatchObject({ docs_seen: 3, claims_written: 1, stopped_by: 'done', last_document_id: 3 });
    expect(summary.usage).toMatchObject({ input_tokens: 4000, output_tokens: 400 });
  });

  it('retries once with the errors, keeping what already passed', async () => {
    const body = 'Concept ACK. Approach ACK as well.';
    const { results, calls } = await run([doc(4, body)], {
      '4/1': [ok('Concept ACK.'), ok('Approach ack as well', { stance: 'approach-ack' })],
      '4/2': [ok('Approach ACK as well.', { stance: 'approach-ack' })],
    });
    expect(results[0].outcome).toBe('claims');
    expect(results[0].claims.map((c) => c.stance)).toEqual(['concept-ack', 'approach-ack']);
    expect(calls).toHaveLength(2);
    const retry = calls[1].messages;
    expect(retry.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(retry[2].content).toContain('"Approach ack as well": quote: not found verbatim');
  });

  it('records refusals and transient errors without stopping', async () => {
    const { results } = await run([doc(5, 'x'), doc(6, 'y'), doc(7, 'Concept ACK.')], {
      5: 'refusal',
      6: new Anthropic.InternalServerError(500, undefined, 'overloaded', new Headers()),
      7: [ok('Concept ACK.')],
    });
    expect(results.map((r) => r.outcome)).toEqual(['refusal', 'error', 'claims']);
  });

  it('stops the run on errors every call would hit', async () => {
    await expect(
      run([doc(8, 'x')], { 8: new Anthropic.AuthenticationError(401, undefined, 'bad key', new Headers()) }),
    ).rejects.toBeInstanceOf(Anthropic.AuthenticationError);
    // No credentials at all: the SDK throws a plain Error before sending anything.
    await expect(
      run([doc(8, 'x')], { 8: new Error('Could not resolve authentication method.') }),
    ).rejects.toThrow('Could not resolve authentication method.');
    await expect(
      run([doc(8, 'x')], { 8: new Anthropic.NotFoundError(404, undefined, 'model not found', new Headers()) }),
    ).rejects.toBeInstanceOf(Anthropic.NotFoundError);
    // Rate limits after the SDK's retries: skip the document, keep going.
    const limited = await run([doc(8, 'x')], { 8: new Anthropic.RateLimitError(429, undefined, 'slow down', new Headers()) });
    expect(limited.results[0].outcome).toBe('error');
    // A dropped connection is per-document, not fatal.
    const { results } = await run([doc(8, 'x')], { 8: new Anthropic.APIConnectionError({ message: 'reset' }) });
    expect(results[0].outcome).toBe('error');
  });

  it('skips documents over the size limit without calling the model', async () => {
    const { results, calls } = await run([doc(9, 'a'.repeat(stanceTask.maxDocChars + 1))], {});
    expect(results[0].outcome).toBe('too_long');
    expect(calls).toHaveLength(0);
  });

  it('stops starting documents once the token budget is used', async () => {
    const { summary, results } = await run([doc(10, 'a'), doc(11, 'b'), doc(12, 'c')], {}, 2000);
    expect(results.map((r) => r.document_id)).toEqual([10, 11]);
    expect(summary).toMatchObject({ stopped_by: 'budget', last_document_id: 11 });
  });

  it('caches the system prompt: it is the same string on every call', async () => {
    const { calls } = await run([doc(13, 'a'), doc(14, 'b')], {});
    expect(calls[0].system).toBe(calls[1].system);
    expect(calls[0].system).toContain('precision matters far more than coverage');
  });

  it('counts cached input at its billed weight', () => {
    // 25,000-token spec read from cache, 1,000 new input, 200 output.
    expect(billedTokens({ input_tokens: 26000, output_tokens: 200, cache_read_tokens: 25000, cache_write_tokens: 0 })).toBe(3700);
    // First request writes the cache.
    expect(billedTokens({ input_tokens: 26000, output_tokens: 200, cache_read_tokens: 0, cache_write_tokens: 25000 })).toBe(32450);
    expect(billedTokens({ input_tokens: 1000, output_tokens: 100 })).toBe(1100);
  });
});
