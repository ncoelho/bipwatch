import type { BipRecord } from '@bipwatch/data';
import type { ModelClient, ModelRequest, ModelResult } from '../src/model.ts';
import type { BipContext, InputDoc } from '../src/types.ts';

export const BIP352 = {
  number: 352,
  title: 'Silent Payments',
  layer: 'Applications',
  type: 'Specification',
  status: 'Complete',
  version: '1.1.2',
  authors: ['josibake'],
  spec: { repo: 'bitcoin/bips', path: 'bip-0352.mediawiki', revision: 'f'.repeat(40), synced: '2026-11-05' },
  bipwatch: { tracked: true },
} as BipRecord;

export const bips = new Map<number, BipContext>([
  [352, { bip: BIP352, versionAt: (d) => (d && d < new Date('2024-05-01') ? '0.0.0' : '1.1.2') }],
]);

export function doc(id: number, body: string, over: Partial<InputDoc> = {}): InputDoc {
  return {
    id,
    source: 'mailing-list',
    external_id: `msg-${id}@example.test`,
    title: 'Silent Payments – Non-interactive private payments',
    thread_title: `Silent Payments thread ${id}`,
    author: 'Alice Example',
    posted_at: new Date('2022-03-29T10:00:00Z'),
    body_text: body,
    url: `https://gnusha.org/pi/bitcoindev/msg-${id}@example.test/`,
    bips: [352],
    ...over,
  };
}

type Stance = { bip: number; stance: string; condition: string | null; statement: string; quote: string };

/** A model that answers from a script, keyed by document id and attempt. */
export function scriptedModel(script: Record<string, Stance[] | 'refusal' | Error>) {
  const calls: ModelRequest<unknown>[] = [];
  const client: ModelClient = {
    async run<Out>(req: ModelRequest<Out>): Promise<ModelResult<Out>> {
      calls.push(req as ModelRequest<unknown>);
      const first = req.messages[0].content as string;
      const id = first.match(/^Thread: Silent Payments thread (\d+)$/m)?.[1] ?? '?';
      const attempt = Math.ceil(req.messages.length / 2);
      const answer = script[`${id}/${attempt}`] ?? script[id] ?? [];
      const usage = { input_tokens: 1000, output_tokens: 100 };
      if (answer instanceof Error) throw answer;
      if (answer === 'refusal') return { output: null, stop: 'refusal', text: '', usage, model: req.model };
      const output = { stances: answer } as Out;
      return { output, stop: 'ok', text: JSON.stringify(output), usage, model: req.model };
    },
  };
  return { client, calls };
}
