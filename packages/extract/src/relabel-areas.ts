/**
 * One-off migration (2026-11-13): the open-work area "spec" split into
 * "design" (deciding how the protocol works) and "writing" (editing the
 * document). For each claim still marked spec, the model reads only its kind,
 * part_of, statement and quote and picks one of the two; code changes nothing
 * else in the file. The result goes through a pull request like any other
 * machine output.
 *
 *   npm run relabel-areas -- [--dry-run]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { findDataDir, type Claim } from '@bipwatch/data';
import { parse } from 'yaml';
import { z } from 'zod';
import { claudeClient } from './model.ts';
import { claimYaml } from './store.ts';
import { billedTokens, type Usage } from './types.ts';

const BATCH = 15;
const SYSTEM = `You sort open-work items about Bitcoin Improvement Proposals into one of two types of work. Each item is a task, open question or objection someone raised in public discussion, with a statement of the work and a quote from the source.

- design: deciding how the protocol should work, such as an open design decision, a choice between alternatives, a parameter, or a problem with how it behaves that needs a different design or an argument. Most open questions and objections are design.
- writing: editing a spec document without changing its design, such as a clarification, a warning, a missing section, an explanation, or a misleading or wrong passage.

When an item asks to specify or define something that has not been decided yet, it is design. When the decision is made and the document only needs to say it, or say it better, it is writing.

Return one answer per item, with the item's id exactly as given.`;

const Output = z.object({ items: z.array(z.object({ id: z.string(), area: z.enum(['design', 'writing']) })) });

const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
const dataDir = findDataDir();
const files: { file: string; claim: Claim }[] = [];
for (const folder of readdirSync(join(dataDir, 'bips'))) {
  const dir = join(dataDir, 'bips', folder, 'claims');
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.yaml'));
  } catch {
    continue;
  }
  for (const n of names) {
    const claim = parse(readFileSync(join(dir, n), 'utf8')) as Omit<Claim, 'area'> & { area?: string };
    if (claim.area === 'spec') files.push({ file: join(dir, n), claim: claim as Claim });
  }
}
console.log(`${files.length} claims with area spec${values['dry-run'] ? ' · dry run' : ''}`);

const model = claudeClient();
let usage: Usage = { input_tokens: 0, output_tokens: 0 };
const counts = { design: 0, writing: 0 };
for (let i = 0; i < files.length; i += BATCH) {
  const batch = files.slice(i, i + BATCH);
  const message = batch
    .map(({ claim: c }) =>
      [`<item id="${c.id}">`, `kind: ${c.kind}`, `about: ${c.part_of ?? `BIP ${c.bip} itself`}`, `statement: ${c.statement}`, `quote: ${c.source.quote}`, '</item>'].join('\n'),
    )
    .join('\n\n');
  const res = await model.run({
    model: 'claude-opus-5-5',
    effort: 'low',
    system: SYSTEM,
    messages: [{ role: 'user', content: message }],
    schema: Output,
  });
  usage = {
    input_tokens: usage.input_tokens + res.usage.input_tokens,
    output_tokens: usage.output_tokens + res.usage.output_tokens,
    cache_read_tokens: (usage.cache_read_tokens ?? 0) + (res.usage.cache_read_tokens ?? 0),
    cache_write_tokens: (usage.cache_write_tokens ?? 0) + (res.usage.cache_write_tokens ?? 0),
  };
  if (!res.output) throw new Error(`batch ${i / BATCH + 1}: model returned ${res.stop}`);
  const byId = new Map(res.output.items.map((it) => [it.id, it.area]));
  for (const { file, claim } of batch) {
    const area = byId.get(claim.id);
    // A missing answer leaves the file as it is; the validator then flags it.
    if (!area) {
      console.log(`  ? ${claim.id}: no answer`);
      continue;
    }
    counts[area]++;
    console.log(`  ${area.padEnd(7)} ${claim.id}  ${claim.statement.slice(0, 90)}`);
    if (!values['dry-run']) writeFileSync(file, claimYaml({ ...claim, area }));
  }
}
console.log(`Done: ${counts.design} design, ${counts.writing} writing · ${billedTokens(usage)} billed-equivalent tokens`);
