export const typeNames = {
  single: '单选',
  multiple: '多选',
  judge: '判断',
  fill: '填空',
  short: '解答',
};
export const questionTypes = Object.keys(typeNames);
export const objective = (type) => ['single', 'multiple', 'judge'].includes(type);
export const objectiveRubric = (type) =>
  type === 'multiple'
    ? '全部选对得本题满分；漏选、多选、错选或未答均为零分，不计过程分。'
    : '选择正确得本题满分；选择错误或未答为零分，不计过程分。';
export const issueNames = {
  answer: '答案或解析有误',
  conditions: '求解条件不完整',
  type: '题型或评分规则冲突',
  duplicate: '题目重复',
  leakage: '题间泄露答案',
  scope: '超出考试范围',
  workload: '作答量超出时间安排',
  style: '措辞建议',
  balance: '分布建议',
  uncertainty: '正确性尚无法确认',
};
export function sections(slots) {
  const result = [];
  for (const slot of slots) {
    let section = result.at(-1);
    if (section?.type !== slot.type) {
      section = { type: slot.type, count: 0, points: 0, start: slot.id };
      result.push(section);
    }
    section.count++;
    section.points += slot.points;
  }
  return result;
}
