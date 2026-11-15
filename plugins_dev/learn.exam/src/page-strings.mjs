export const zh = {
  introLabel: '学习试卷使用说明',
  intro: [
    ['按学过的内容出卷：', '在对话里说明考试范围和要求，材料不足时先确认，再准备试卷。'],
    ['准备好再计时：', '先规划题型与分值，逐题编写并整卷审核；点击开始考试后才倒计时。'],
    ['交卷前隐藏答案：', '在学习模式右侧专心作答，提交后查看参考答案、评分与解析。'],
    ['记录留在本机：', '作答自动保存，可以回看历史试卷、重新考试或回到对话继续讲解。'],
  ],
  featuresTitle: '插件功能',
  features: [
    {
      icon: 'message-square',
      title: '根据学习范围出卷',
      detail:
        '使用当前会话的模型出卷与批改，可补充知识点、难度、题量和时长。默认 10 题、30 分钟、适中难度。',
    },
    {
      icon: 'blocks',
      title: '题型与分值规划',
      detail:
        '支持单选、多选、判断、填空和解答题，可指定各题型数量。每卷 3–20 题、5–180 分钟，总分 100 分。',
    },
    {
      icon: 'shield-check',
      title: '逐题编写，整卷审核',
      detail:
        '先固定试卷结构，再依次生成题目，最后统一核对答案与评分标准。有问题时定向修订，进度保存在当前试卷中。',
    },
    {
      icon: 'circle-dashed',
      title: '计时模拟考试',
      detail:
        '主动开始后计时，交卷前不展示答案和解析。可以提前交卷，到时自动封存已保存的作答；离开页面或关闭应用不会暂停考试。',
    },
    {
      icon: 'list-tree',
      title: '答题导航与自动保存',
      detail:
        '右侧答题卡按题型快速跳题，区分已答、未答和待检查题目。窄窗口可收起导航，保存状态持续可见，重启后可继续未到时的考试。',
    },
    {
      icon: 'file-text',
      title: '批改与考后复盘',
      detail:
        '交卷后逐题查看得分与解析，解答题支持过程分。不确定项标为待复核；可回到对话讲解指定题目，或新建一次重考记录。',
    },
  ],
  usageTitle: '开始使用',
  usage:
    '启用插件后，切换到学习模式，从右侧打开「试卷」。点击「试卷」将提示标记加入输入框，补充要求后发送。试卷准备好后点击「开始考试」，交卷后再批改与复盘。你可以这样补充要求：',
  example:
    '根据刚学过的一元二次方程出一份试卷：10 题、30 分钟、适中难度。单选 4 题、多选 2 题、判断 2 题、填空 1 题、解答 1 题，重点考查应用。',
};

export const en = {
  introLabel: 'How Learning Exam works',
  intro: [
    [
      'Based on your learning: ',
      'Describe the scope and requirements in chat; missing context is clarified before the paper is prepared.',
    ],
    [
      'Prepare before timing: ',
      'Question types and points are planned first, followed by questions and a whole-paper review. The timer starts when you begin.',
    ],
    [
      'Answers stay hidden: ',
      'Take the exam beside your Learn chat, then view reference answers, marks and explanations after submission.',
    ],
    [
      'Records stay local: ',
      'Responses are saved automatically. Revisit past papers, retake an exam or discuss a question in chat.',
    ],
  ],
  featuresTitle: 'Plugin features',
  features: [
    {
      icon: 'message-square',
      title: 'Papers based on your learning',
      detail:
        'Use the current conversation’s model to create and mark papers. Add topics, difficulty, question count and duration. Defaults to 10 questions, 30 minutes and moderate difficulty.',
    },
    {
      icon: 'blocks',
      title: 'Question types and points',
      detail:
        'Choose single choice, multiple choice, true or false, fill in the blanks and written answers. Set counts by type, with 3–20 questions, 5–180 minutes and 100 points per paper.',
    },
    {
      icon: 'shield-check',
      title: 'Generate questions, review the paper',
      detail:
        'Fix the structure, write each question, then review answers and marking criteria together. Issues receive targeted revisions, with progress saved to the paper.',
    },
    {
      icon: 'circle-dashed',
      title: 'Timed mock exams',
      detail:
        'Start the timer yourself. Answers and explanations remain hidden until submission. Submit early or have saved responses sealed at the deadline; leaving the page or closing the app does not pause the exam.',
    },
    {
      icon: 'list-tree',
      title: 'Question navigation and saving',
      detail:
        'Jump by question type and track answered, unanswered and flagged questions. Collapse navigation in narrow windows, check save status and resume after restarting before the deadline.',
    },
    {
      icon: 'file-text',
      title: 'Marking and review',
      detail:
        'After submission, inspect marks and explanations for each question. Written answers support partial credit and uncertain results are flagged for review. Discuss a question in chat or create a separate retake.',
    },
  ],
  usageTitle: 'Get started',
  usage:
    'Enable the plugin, switch to Learn and open 试卷 (Exam) on the right. Click 试卷 to add its prompt label to the composer, add your requirements and send. Start when the paper is ready, then request marking after submission. For example:',
  example:
    'Create a moderate exam on the quadratic equations we just studied: 10 questions in 30 minutes, with 4 single choice, 2 multiple choice, 2 true or false, 1 fill in the blanks and 1 written answer. Focus on applications.',
};
