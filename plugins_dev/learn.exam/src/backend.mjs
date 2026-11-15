import { createExam, migrations } from './exam.mjs';
export async function apply(context) {
  const database = await context.storage.openDatabase({ name: 'exam', migrations });
  const exam = await createExam(database);
  context.commands.register('load-exam', exam.load);
  context.commands.register('exam-action', exam.action);
  context.tools.register('prepare', exam.prepare);
  context.tools.register('grade', exam.grade);
  context.tools.register('review', exam.review);
  context.tools.interaction({ policy: async () => null, finished: exam.finished });
  context.onDispose(async () => {
    await exam.dispose();
    await database.close();
  });
}
