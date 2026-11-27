import { copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);
await build({
  absWorkingDir: root,
  entryPoints: ['src/three-office.mjs'],
  outfile: 'plugin/vendor/three-office.mjs',
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'chrome140',
  legalComments: 'eof',
});
await copyFile(
  resolve(require.resolve('three'), '../../LICENSE'),
  resolve(root, 'plugin/vendor/THREE-LICENSE.txt'),
);
