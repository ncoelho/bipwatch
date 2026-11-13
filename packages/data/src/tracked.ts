// Prints the tracked BIP numbers as a JSON array, e.g. [352]. Used by the
// extraction workflow to run (and open a pull request) once per BIP.
import { findDataDir, loadAll } from './index.ts';

const dataDir = findDataDir(process.env.INIT_CWD);
const numbers = loadAll(dataDir)
  .filter((b) => b.bip.bipwatch.tracked)
  .map((b) => b.bip.number)
  .sort((a, b) => a - b);
process.stdout.write(`${JSON.stringify(numbers)}\n`);
