import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const directory of ['src', 'tests', 'scripts'])
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], {
      stdio: 'inherit',
    });
    if (result.status) process.exit(result.status);
  }
console.log('脚本语法检查通过。');
