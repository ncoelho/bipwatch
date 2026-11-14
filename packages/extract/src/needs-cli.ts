/**
 * npm run needs -- [--bip <n>]... [--if-changed] [--dry-run]
 *
 * Regenerates bips/<NNNN>/needs.yaml for tracked BIPs (default: every tracked
 * BIP with at least one claim) from the claims in the folder. --if-changed
 * skips BIPs with no claim extracted after their last assessment. One model call
 * per BIP, plus one retry if it cites ids that do not exist. Writes with
 * reviewed_by: null; changes reach main through a pull request.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { findDataDir, folderFor, loadAll, NEED_DIMENSIONS } from '@bipwatch/data';
import { claudeClient } from './model.ts';
import { checkNeeds, needsDigest, needsYaml, NEEDS_MODEL, NEEDS_SYSTEM, NeedsOutput, toAssessment } from './needs.ts';
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
    b.claims.length > 0 &&
    (!only.size || only.has(b.bip.number)) &&
    (!values['if-changed'] || !b.needs || b.claims.some((c) => c.provenance.extracted > b.needs!.assessed)),
);
const today = new Date().toISOString().slice(0, 10);
const model = claudeClient();
let usage: Usage = { input_tokens: 0, output_tokens: 0 };

for (const bundle of bundles) {
  const ids = new Set(bundle.claims.map((c) => c.id));
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: needsDigest(bundle) }];
  let out: NeedsOutput | null = null;
  let used = NEEDS_MODEL;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await model.run({ model: NEEDS_MODEL, effort: 'medium', system: NEEDS_SYSTEM, messages, schema: NeedsOutput });
    usage = {
      input_tokens: usage.input_tokens + res.usage.input_tokens,
      output_tokens: usage.output_tokens + res.usage.output_tokens,
      cache_read_tokens: (usage.cache_read_tokens ?? 0) + (res.usage.cache_read_tokens ?? 0),
      cache_write_tokens: (usage.cache_write_tokens ?? 0) + (res.usage.cache_write_tokens ?? 0),
    };
    used = res.model;
    if (!res.output) throw new Error(`BIP ${bundle.bip.number}: model returned ${res.stop}`);
    const errors = checkNeeds(res.output, ids);
    if (!errors.length) {
      out = res.output;
      break;
    }
    console.log(`  BIP ${bundle.bip.number} attempt ${attempt}: ${errors.join('; ')}`);
    messages.push({ role: 'assistant', content: res.text });
    messages.push({ role: 'user', content: `Fix these problems and return the whole assessment again:\n${errors.map((e) => `- ${e}`).join('\n')}` });
  }
  if (!out) {
    console.log(`BIP ${bundle.bip.number}: skipped, the assessment still had errors`);
    continue;
  }
  const assessment = toAssessment(out, bundle.bip.number, today, used);
  console.log(`BIP ${bundle.bip.number} (${bundle.claims.length} claims)`);
  for (const d of NEED_DIMENSIONS) {
    const x = assessment.dimensions[d];
    console.log(`  ${d.padEnd(20)} ${x.score ?? '–'}  ${x.rationale}`);
  }
  if (!values['dry-run']) writeFileSync(join(dataDir, 'bips', folderFor(bundle.bip.number), 'needs.yaml'), needsYaml(assessment));
}
console.log(`Done: ${bundles.length} BIPs · ${billedTokens(usage)} billed-equivalent tokens${values['dry-run'] ? ' · dry run' : ''}`);
