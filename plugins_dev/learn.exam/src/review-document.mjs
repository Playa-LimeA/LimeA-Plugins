import { typeNames } from './question-types.mjs';

// A read-only projection of persisted questions, never a second editable paper.
export function reviewDocument(paper) {
  const { spec, blueprint, questions } = paper;
  const lines = [
    `# ${spec.title}`,
    `${spec.questionCount}题 / 100分 / ${spec.durationMinutes}分钟 / ${spec.difficulty}`,
    '## 学习范围',
    spec.learningContext,
    '## 固定题型与内容',
  ];
  for (const slot of blueprint.slots) {
    const q = questions[slot.id];
    lines.push(
      `### ${slot.id} ${typeNames[slot.type]} / ${slot.points}分 / ${slot.minutes}分钟`,
      `考点：${slot.topic}`,
      q.stem,
      ...q.options.map((o) => `${o.id}. ${o.text}`),
      `正确选项：${q.correctOptions.join('、') || '无'}`,
      ...(q.blanks ?? []).map((b) => `空${b.id}（${b.points}分）允许答案：${b.answers.join('；')}`),
      `参考答案：${q.referenceAnswer}`,
      `评分：${q.rubric}`,
      `解析：${q.explanation}`,
      `依据：${q.basis}`,
    );
  }
  return lines.join('\n\n');
}
export function reviewData(paper, verify = false) {
  const data = { document: reviewDocument(paper) };
  if (verify) {
    data.changedIds = paper.generation.changedIds;
    data.previousIssues = paper.generation.issues
      .filter((i) => i.severity === 'blocking')
      .map(({ questionIds, category, reason }) => ({
        questionIds,
        category,
        reason: reason.slice(0, 120),
      }));
    while (
      JSON.stringify(data.previousIssues).length > 4000 &&
      data.previousIssues.some((i) => i.reason.length)
    )
      for (const issue of data.previousIssues)
        issue.reason = issue.reason.slice(0, Math.max(0, issue.reason.length - 20));
  }
  return data;
}
