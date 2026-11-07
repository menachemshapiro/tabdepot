import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeSite } from './helpers.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
writeSite();
const only = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs') && (!only || f.includes(only))).sort();
let failed = 0;
for (const f of files) {
  console.log(`\n# ${f}`);
  try {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    failed += (await mod.default()) || 0;
  } catch (e) {
    console.log(`  FAIL  ${f} crashed: ${e.stack || e}`);
    failed++;
  }
}
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
