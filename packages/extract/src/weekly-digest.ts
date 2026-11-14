/**
 * npm run weekly-digest -- [--week 2026-W46] [--dry-run]
 *
 * Drafts the homepage's lead story for a week into data/weekly/<week>.yaml.
 * Code picks the story: the busiest thread this week whose title names a
 * tracked BIP (from data/generated/week.json). The model writes only the
 * headline, the two-sentence lead and which data tiles to show, from a short
 * digest of facts; it never sees or invents numbers it can't cite. The file
 * reaches the site through a pull request: merging approves the story.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { findDataDir, folderFor, isoWeek, loadBip, loadWeek, type WeeklyStory } from '@bipwatch/data';
import { stringify } from 'yaml';
import { z } from 'zod';
import { claudeClient } from './model.ts';
import { billedTokens } from './types.ts';

const { values } = parseArgs({ options: { week: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
const dataDir = findDataDir();
const week = values.week ?? isoWeek();
const file = join(dataDir, 'weekly', `${week}.yaml`);
if (existsSync(file) && !values['dry-run']) {
  console.log(`weekly-digest: ${week} already has a story; leaving it.`);
  process.exit(0);
}
const data = loadWeek(dataDir);
if (!data) throw new Error('No data/generated/week.json; run npm run site-exports first.');

// The busiest thread about one tracked BIP.
const tracked = (n: number) => existsSync(join(dataDir, 'bips', folderFor(n))) && loadBip(folderFor(n), dataDir).bip.bipwatch.tracked;
const pick = data.hot.find((h) => h.bips.length === 1 && tracked(h.bips[0]));
if (!pick) {
  console.log('weekly-digest: no thread this week is about a tracked BIP; no story.');
  process.exit(0);
}
const b = loadBip(folderFor(pick.bips[0]), dataDir);
const impls = b.claims.filter((c) => c.kind === 'implementation');
const prUrl = pick.url.match(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0];
const gap = b.road?.steps.find((s) => s.state === 'gap');
const tileKeys = [
  ...(b.bip.status_since ? ['status_age'] : []),
  ...(prUrl ? [`pr_age:${prUrl}`] : []),
  ...impls.map((c) => `implementation:${c.id}`),
  ...(gap ? ['road_gap'] : []),
  'open_work',
];
const digest = [
  `Week: ${data.from} to ${data.to}.`,
  `Busiest thread about a tracked BIP: "${pick.title}" on ${pick.source}, ${pick.posts} posts this week. ${pick.url}`,
  `BIP ${b.bip.number}: ${b.bip.title}. Layer: ${b.bip.layer}. Status: ${b.bip.status}${b.bip.status_since ? ` since ${b.bip.status_since}` : ''}.`,
  b.bip.bipwatch.summary ? `Summary: ${b.bip.bipwatch.summary}` : '',
  impls.length ? `Implementations: ${impls.map((c) => `[${c.id}] ${c.subject?.name}: ${c.implementation!.state}`).join('; ')}.` : '',
  gap ? `Road to activation: the next missing step is "${gap.title}": ${gap.text}` : '',
  `Tiles available: ${tileKeys.join(', ')}.`,
].filter(Boolean).join('\n');

const SYSTEM = `You write the lead story for BipWatch's weekly front page about Bitcoin Improvement Proposals. You get a short digest of facts. Write:
- kind: what the story is about (implementation, status, discussion, draft, spec or activation).
- headline: one plain sentence, under 120 characters, saying what happened this week. No hype, no question.
- lead: two plain sentences giving the context a reader needs. Use only the facts in the digest. Do not write numbers or counts: the tiles show them. Dates are fine.
- tiles: up to four keys from "Tiles available", the most telling first.
- sources: the claim ids in brackets that the story rests on (may be empty).
- link_label: a short label for a button to the thread, such as "Read the pull request" or "Read the thread".`;
const Out = z.object({
  kind: z.enum(['implementation', 'status', 'discussion', 'draft', 'spec', 'activation']),
  headline: z.string(),
  lead: z.string(),
  tiles: z.array(z.string()),
  sources: z.array(z.string()),
  link_label: z.string(),
});
const res = await claudeClient().run({ model: 'claude-opus-5-5', effort: 'medium', system: SYSTEM, messages: [{ role: 'user', content: digest }], schema: Out });
if (!res.output) throw new Error(`model returned ${res.stop}`);
const o = res.output;
const ids = new Set(b.claims.map((c) => c.id));
const today = new Date().toISOString().slice(0, 10);
const story: WeeklyStory = {
  week,
  bip: b.bip.number,
  kind: o.kind,
  headline: o.headline.trim(),
  lead: o.lead.trim(),
  link: { label: o.link_label.trim(), url: pick.url },
  tiles: o.tiles.filter((t) => tileKeys.includes(t)).slice(0, 4),
  // The claims the tiles show are sources too, whatever the model listed.
  sources: [...new Set([...o.sources, ...o.tiles.filter((t) => t.startsWith('implementation:')).map((t) => t.slice(15))])].filter((s) => ids.has(s)),
  provenance: { extracted_by: `model:${res.model}`, extracted: today, reviewed_by: null },
};
const yaml = [
  `# Lead story for ${week} (${data.from} to ${data.to}), drafted by npm run weekly-digest`,
  `# from the busiest thread about a tracked BIP. Merging the pull request approves it.`,
  stringify(story, { lineWidth: 80 }),
].join('\n');
console.log(yaml);
console.log(`weekly-digest: ${billedTokens(res.usage)} billed-equivalent tokens${values['dry-run'] ? ' · dry run' : ''}`);
if (!values['dry-run']) {
  mkdirSync(join(dataDir, 'weekly'), { recursive: true });
  writeFileSync(file, yaml);
}
