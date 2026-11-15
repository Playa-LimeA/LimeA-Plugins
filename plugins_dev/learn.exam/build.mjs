import { build } from 'esbuild';
import { mkdir, cp, readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { jsonSchema, prepareSchema, gradeInputSchema, reviewInputSchema } from './src/schemas.mjs';
process.chdir(fileURLToPath(new URL('.', import.meta.url)));
await mkdir('dist/assets/fonts', { recursive: true });
for (const name of ['backend', 'panel'])
  await build({
    entryPoints: [`src/${name}.mjs`],
    outfile: `dist/${name}.mjs`,
    bundle: true,
    format: 'esm',
    platform: name === 'backend' ? 'node' : 'browser',
    target: name === 'backend' ? 'node24' : 'chrome140',
    loader: { '.css': 'text' },
  });
await cp('node_modules/katex/dist/katex.min.css', 'dist/assets/katex.min.css');
const fonts = (await readdir('node_modules/katex/dist/fonts')).filter((f) => /\.woff2?$/.test(f));
for (const font of fonts)
  await cp(`node_modules/katex/dist/fonts/${font}`, `dist/assets/fonts/${font}`);
const manifest = {
  id: 'learn.exam',
  name: '学习试卷',
  version: '0.2.0',
  apiVersion: 13,
  hostVersion: '>=0.1.0 <1.0.0',
  entry: 'backend.mjs',
  permissions: ['fs:plugin-data', 'model:private-task'],
  resources: ['assets/katex.min.css', ...fonts.map((f) => `assets/fonts/${f}`)],
  panels: [
    {
      id: 'learn.exam.paper',
      name: '试卷',
      entry: 'panel.mjs',
      icon: 'icon.png',
      placement: 'tab',
      modes: ['learn'],
    },
  ],
  tools: [
    {
      id: 'prepare',
      name: '制作学习试卷',
      description:
        '根据当前学习进度制作计时模拟试卷：先定题型数量/考点/分值，固定模板逐题生成，汇总整卷审核一次，通过后发布。支持single单选、multiple多选、judge判断、fill填空、short解答；用户指定数量时在spec.questionTypes传非零项，合计必须等于questionCount，否则可省略自动规划。create从当前对话整理learningContext，依据不足先询问；不把讨论过等同掌握，不提供答案参数。默认10题30分钟适中，支持3-20题/5-180分钟。实质问题最多一轮自动定向修订再复核。resume使用原paperId，仅用户主动要求后继续，暂停时不要自动反复调用。就绪后提示右侧开考，禁止透露未交卷答案。',
      inputSchema: jsonSchema(prepareSchema),
      access: 'local',
      panelId: 'learn.exam.paper',
    },
    {
      id: 'grade',
      name: '批改学习试卷',
      description:
        '批改当前会话已交卷的attemptId，保留已完成批改，可在用户主动要求后继续未完成部分。考试尚未提交时拒绝。待复核项不能作为确定总分。',
      inputSchema: jsonSchema(gradeInputSchema),
      access: 'local',
      panelId: 'learn.exam.paper',
    },
    {
      id: 'review',
      name: '查看试卷复盘',
      description:
        '仅查询当前会话已交卷记录。不传attemptId返回最近十条摘要；传attemptId返回单次概况；再传questionId返回该题作答、答案和评分，供考后讲解。不能查询未交卷答案。',
      inputSchema: jsonSchema(reviewInputSchema),
      access: 'read',
      panelId: 'learn.exam.paper',
    },
  ].map((tool) => ({ ...tool, modes: ['learn'] })),
};
await writeFile('dist/limea.plugin.json', JSON.stringify(manifest, null, 2) + '\n');
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(file, `dist/${file}`);
await cp('assets/icon.png', 'dist/icon.png');
await writeFile('dist/KATEX-LICENSE', await readFile('node_modules/katex/LICENSE'));
await writeFile('dist/ZOD-LICENSE', await readFile('node_modules/zod/LICENSE'));
console.log('构建完成：导入 plugins_dev/learn.exam/dist（需要接口版本13）。');
