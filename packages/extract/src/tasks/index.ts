import type { Task } from '../task.ts';
import { stanceTask } from './stance/index.ts';
import { workTask } from './work/index.ts';

/** Tasks by id. SPEC 6.2 lists the rest in order of value. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TASKS: Record<string, Task<any>> = {
  stance: stanceTask,
  work: workTask,
};
