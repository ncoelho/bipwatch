/**
 * npm run topics -- [--bip <n>]... [--if-changed] [--dry-run]
 *
 * Writes bips/<NNNN>/topics.yaml for tracked BIPs (default: every tracked BIP
 * with two or more open items on one piece): open work items that ask for
 * the same thing. --if-changed skips BIPs with no work item extracted after
 * their last grouping. One model call per BIP, plus one retry when code finds
 * problems; groups that still fail are dropped. Writes with reviewed_by:
 * null; changes reach main through a pull request.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { findDataDir, folderFor, loadAll } from '@bipwatch/data';
import { claudeClient } from './model.ts';
import { checkTopics, openWork, toTopics, TOPICS_MODEL, TOPICS_SYSTEM, topicsDigest, topicsYaml, TopicsOutput, validTopics, WORK } from './topics.ts';
import { billedTokens, type Usage } from './types.ts';

const { values } = parseArgs({
  options: {
    bip: { type: 'string', multiple: true, default: [] },
    'if-changed': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});
const dataDir = findDataDir();
const only = new Set(values.bip!.map(Number));
const bundles = loadAll(dataDir).filter(
  (b) =>
    b.bip.bipwatch.tracked &&
    openWork(b).length >= 2 &&
    (!only.size || only.has(b.bip.number)) &&
    (!values['if-changed'] || !b.topics || b.claims.some((c) => WORK.includes(c.kind) && c.provenance.extracted > b.topics!.grouped)),
);
const today = new Date().toISOString().slice(0, 10);
const model = claudeClient();
let usage: Usage = { input_tokens: 0, output_tokens: 0 };

for (const bundle of bundles) {
  const file = join(dataDir, 'bips', folderFor(bundle.bip.number), 'topics.yaml');
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: topicsDigest(bundle) }];
  let out: TopicsOutput | null = null;
  let used = TOPICS_MODEL;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await model.run({ model: TOPICS_MODEL, effort: 'medium', system: TOPICS_SYSTEM, messages, schema: TopicsOutput });
    usage = {
      input_tokens: usage.input_tokens + res.usage.input_tokens,
      output_tokens: usage.output_tokens + res.usage.output_tokens,
      cache_read_tokens: (usage.cache_read_tokens ?? 0) + (res.usage.cache_read_tokens ?? 0),
      cache_write_tokens: (usage.cache_write_tokens ?? 0) + (res.usage.cache_write_tokens ?? 0),
    };
    used = res.model;
    if (!res.output) throw new Error(`BIP ${bundle.bip.number}: model returned ${res.stop}`);
    out = res.output;
    const errors = checkTopics(out, bundle);
    if (!errors.length) break;
    console.log(`  BIP ${bundle.bip.number} attempt ${attempt}: ${errors.join('; ')}`);
    if (attempt === 2) {
      out = validTopics(out, bundle);
      console.log(`  BIP ${bundle.bip.number}: kept the ${out.topics.length} topics that pass`);
      break;
    }
    messages.push({ role: 'assistant', content: res.text });
    messages.push({ role: 'user', content: `Fix these problems and return all the topics again:\n${errors.map((e) => `- ${e}`).join('\n')}` });
  }
  const topics = toTopics(out!, bundle.bip.number, today, used);
  const grouped = topics.topics.reduce((n, t) => n + t.items.length, 0);
  console.log(`BIP ${bundle.bip.number}: ${openWork(bundle).length} open items, ${topics.topics.length} topics holding ${grouped}`);
  for (const t of topics.topics) console.log(`  ${t.items.length}× ${t.title}`);
  if (values['dry-run']) continue;
  if (topics.topics.length) writeFileSync(file, topicsYaml(topics));
  else if (existsSync(file)) rmSync(file);
}
console.log(`Done: ${bundles.length} BIPs · ${billedTokens(usage)} billed-equivalent tokens${values['dry-run'] ? ' · dry run' : ''}`);
