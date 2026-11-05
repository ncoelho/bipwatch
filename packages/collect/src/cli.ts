import { parseArgs } from 'node:util';
import { connect } from './db.ts';
import { buildMentionContext } from './mentions.ts';
import { runCollector } from './run.ts';
import type { Collector, SourceId } from './types.ts';
import { bipsRepoCollector } from './collectors/bips-repo.ts';
import { delvingCollector } from './collectors/delving.ts';
import { mailingListCollector } from './collectors/mailing-list.ts';

/** Collectors are registered here as they are written (SPEC 6.1). */
const COLLECTORS: Partial<Record<SourceId, () => Collector>> = {
  'bips-repo': () => bipsRepoCollector(),
  delving: () => delvingCollector(),
  'mailing-list': () => mailingListCollector(),
};
const ALL: SourceId[] = ['bips-repo', 'github', 'delving', 'mailing-list'];

const { values } = parseArgs({
  options: { source: { type: 'string', multiple: true }, all: { type: 'boolean' } },
});

const wanted: SourceId[] = values.all ? ALL : ((values.source ?? []) as SourceId[]);
if (!wanted.length) {
  console.error('Usage: npm run collect -- --source <id> [--source <id>] | --all');
  console.error(`Sources: ${ALL.join(', ')}`);
  process.exit(2);
}
for (const s of wanted) {
  if (!ALL.includes(s)) {
    console.error(`Unknown source "${s}". Sources: ${ALL.join(', ')}`);
    process.exit(2);
  }
}

let pool: ReturnType<typeof connect>;
try {
  pool = connect();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const ctx = buildMentionContext();
let failed = false;
try {
  for (const source of wanted) {
    const make = COLLECTORS[source];
    if (!make) {
      console.error(`${source}: not implemented yet`);
      failed = true;
      continue;
    }
    const r = await runCollector(pool, make(), ctx);
    console.log(
      `${source}: ${r.ok ? 'ok' : 'FAILED'} · ${r.items_new} new of ${r.items_seen} seen · cursor ${r.cursor_after ?? '-'}`,
    );
    if (!r.ok) {
      console.error(r.error);
      failed = true;
    }
  }
} finally {
  await pool.end();
}
process.exitCode = failed ? 1 : 0;
