/**
 * npm run tag-fixes -- --bip <n> [--dry-run] [--all]
 *
 * For a BIP with a fixes.yaml (BIP 54), tags each claim with the fix it is
 * about: fix:<key>, or topic:activation, or nothing for the proposal as a
 * whole. The model reads only the claim's kind, statement and quote, and the
 * fix list; code writes only the tags line. Claims that already carry a fix
 * or topic tag are skipped unless --all. Pending review like any claim.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { findDataDir, folderFor, loadBip } from '@bipwatch/data';
import { z } from 'zod';
import { claudeClient } from './model.ts';
import { claimYaml } from './store.ts';
import { billedTokens, type Usage } from './types.ts';

const BATCH = 15;
const { values } = parseArgs({
  options: { bip: { type: 'string' }, 'dry-run': { type: 'boolean', default: false }, all: { type: 'boolean', default: false } },
});
const n = Number(values.bip);
const dataDir = findDataDir();
const folder = folderFor(n);
const bundle = loadBip(folder, dataDir);
if (!bundle.fixes) throw new Error(`BIP ${n} has no fixes.yaml`);
const keys = bundle.fixes.fixes.map((f) => f.key);
const SYSTEM = `You sort statements about Bitcoin Improvement Proposal ${n} (${bundle.bip.title}) by which of its separate fixes each one is about.

The fixes:
${bundle.fixes.fixes.map((f) => `- ${f.key}: ${f.name}. ${f.rule}`).join('\n')}

Answer for each item, by its id:
- one fix key, when the item is about that fix (its rule, its threat, its design, its implementation or its tests);
- "activation", when it is about deploying the soft fork as a whole: activation method, timing, signaling, miner readiness for activation in general;
- "whole", when it is about the proposal as a whole or several fixes at once, or none of the above.

Pick one answer per item.`;
const Output = z.object({ items: z.array(z.object({ id: z.string(), about: z.enum(['activation', 'whole', ...keys] as [string, ...string[]]) })) });

const isTagged = (tags?: string[]) => tags?.some((t) => t.startsWith('fix:') || t.startsWith('topic:'));
const todo = bundle.claims.filter((c) => values.all || !isTagged(c.tags));
console.log(`BIP ${n}: ${todo.length} of ${bundle.claims.length} claims to tag${values['dry-run'] ? ' · dry run' : ''}`);

const model = claudeClient();
let usage: Usage = { input_tokens: 0, output_tokens: 0 };
const counts: Record<string, number> = {};
for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  const res = await model.run({
    model: 'claude-opus-5-5',
    effort: 'low',
    system: SYSTEM,
    messages: [{ role: 'user', content: batch.map((c) => [`<item id="${c.id}">`, `kind: ${c.kind}`, `statement: ${c.statement}`, `quote: ${c.source.quote ?? ''}`, '</item>'].join('\n')).join('\n\n') }],
    schema: Output,
  });
  usage = {
    input_tokens: usage.input_tokens + res.usage.input_tokens,
    output_tokens: usage.output_tokens + res.usage.output_tokens,
    cache_read_tokens: (usage.cache_read_tokens ?? 0) + (res.usage.cache_read_tokens ?? 0),
    cache_write_tokens: (usage.cache_write_tokens ?? 0) + (res.usage.cache_write_tokens ?? 0),
  };
  if (!res.output) throw new Error(`batch ${i / BATCH + 1}: model returned ${res.stop}`);
  const about = new Map(res.output.items.map((x) => [x.id, x.about]));
  for (const c of batch) {
    const a = about.get(c.id);
    if (!a) {
      console.log(`  ? ${c.id}: no answer`);
      continue;
    }
    counts[a] = (counts[a] ?? 0) + 1;
    const keep = (c.tags ?? []).filter((t) => !t.startsWith('fix:') && !t.startsWith('topic:'));
    const tags = a === 'whole' ? keep : [...keep, a === 'activation' ? 'topic:activation' : `fix:${a}`];
    console.log(`  ${a.padEnd(10)} ${c.id}`);
    if (values['dry-run']) continue;
    const file = join(dataDir, 'bips', folder, 'claims', `${c.id}.yaml`);
    const { tags: _, ...rest } = c;
    const next = claimYaml({ ...rest, ...(tags.length ? { tags } : {}) });
    // Keep the file as it was except the tags line.
    const before = readFileSync(file, 'utf8');
    const withoutTags = before.replace(/^tags:.*\n(?:  - .*\n)*/m, '');
    const tagLines = next.match(/^tags:.*\n(?:  - .*\n)*/m)?.[0] ?? '';
    writeFileSync(file, withoutTags.trimEnd() + '\n' + tagLines);
  }
}
console.log(`Done: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')} · ${billedTokens(usage)} billed-equivalent tokens`);
