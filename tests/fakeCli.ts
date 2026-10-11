import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The command that starts a fake CLI script. On Windows, Ghost starts CLIs through the shell (real
 * ones are npm .cmd shims), and a bare .mjs there opens in whatever app owns .mjs files instead of
 * running. So the fake gets a .cmd shim of its own, like a real CLI, that runs it with Node.
 */
export function fakeCli(script: string): string {
  if (process.platform !== 'win32') return script;
  const shim = join(mkdtempSync(join(tmpdir(), 'ghost-fake-cli-')), 'fake.cmd');
  writeFileSync(shim, `@"${process.execPath}" "${script}" %*\r\n`);
  return shim;
}
