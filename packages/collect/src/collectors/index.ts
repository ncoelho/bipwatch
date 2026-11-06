import type { Collector, SourceId } from '../types.ts';
import { bipsRepoCollector } from './bips-repo.ts';
import { delvingCollector } from './delving.ts';
import { githubCollector } from './github.ts';
import { mailingListCollector } from './mailing-list.ts';

/** Collectors by source (SPEC 6.1). Constructing one does no network I/O. */
export const COLLECTORS: Record<SourceId, () => Collector> = {
  'bips-repo': () => bipsRepoCollector(),
  delving: () => delvingCollector(),
  'mailing-list': () => mailingListCollector(),
  github: () => githubCollector(),
};

export const ALL_SOURCES: SourceId[] = ['bips-repo', 'github', 'delving', 'mailing-list'];
