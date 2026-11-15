import renderMathInElement from 'katex/contrib/auto-render';
import styles from './panel.css';
import { icon, mountNavigation } from './panel-navigation.mjs';
import { typeNames, issueNames, sections } from './question-types.mjs';

const phaseNames = {
  blueprint: '正在规划考点与题型',
  question: '正在编写题目',
  solve: '正在独立解题核对',
  audit: '正在审核答案与评分标准',
  whole: '正在检查整张试卷',
  repair: '正在修订问题题目',
  verify: '正在复核修订内容',
  grade: '正在批改解答题',
  'grade-fill': '正在批改填空题',
};
const errors = {
  interrupted: '任务已暂停，已完成的部分已保存。',
  'question-review-failed': '有题目未通过复核，继续时会修订该题。',
  'question-format-failed': '题目格式仍未符合要求，已暂停。继续时只重试未完成的题目。',
  'invalid-blueprint': '试卷结构未满足题数、题型、分值或时长要求，请继续规划。',
  'invalid-model-result': '模型未返回有效的题目或审核结果，已保存现有进度。',
  'paper-review-failed': '整卷检查发现问题，继续时会返工相关题目。',
  'model-request-failed': '模型请求未完成，请检查模型连接后继续。',
  'invalid-score': '模型返回的分值不符合评分标准，请继续批改。',
  'question-too-long': '题目内容过长，需要继续修订。',
  'prompt-too-long': '试卷超出单次复核范围，请减少题量或学习材料。',
  'revision-conflict': '答案已被另一处更新，请重新打开试卷核对。',
  'exam-closed': '作答已截止，已封存最后保存的答案。',
  'task-busy': '这份试卷的任务仍在进行中。',
  'exam-already-active': '当前会话还有一份正在作答的试卷，请先完成它。',
};
const verdictNames = {
  correct: '正确',
  partial: '部分得分',
  incorrect: '未得分',
  uncertain: '待复核',
};
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, action, cls = '') {
  const node = el('button', cls, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
function math(text) {
  const node = el('div', 'exam-prose', text);
  renderMathInElement(node, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$', right: '$', display: false },
    ],
    throwOnError: false,
    trust: false,
    strict: 'ignore',
  });
  return node;
}
const hasAnswer = (a) => (Array.isArray(a) ? a.some((v) => v.trim()) : Boolean(a?.trim()));
const countAnswers = (answers) => Object.values(answers ?? {}).filter(hasAnswer).length;
const messageFor = (error) =>
  Object.entries(errors).find(([code]) => String(error?.message ?? error).includes(code))?.[1] ??
  '操作未确认，请检查连接后重试。';

export function mount(container, context) {
  const style = el('style');
  style.textContent = styles;
  const mathStyle = el('link');
  mathStyle.rel = 'stylesheet';
  mathStyle.href = new URL('assets/katex.min.css', context.resourceBase).href;
  const root = el('section', 'exam');
  root.setAttribute('aria-label', '学习试卷');
  container.append(style, mathStyle, root);
  let state = null,
    selection = {},
    visible = true,
    busy = false,
    disposed = false,
    setupMode = false;
  let draft = {},
    marked = [],
    dirty = false,
    editVersion = 0,
    confirmedVersion = 0,
    baseRevision = 0,
    reservedRevision = 0,
    saveError = '';
  const writes = new Set();
  let pendingWrite = null;
  let layoutKey = '',
    requestVersion = 0,
    notice = '',
    confirming = false,
    offset = 0;
  let clock,
    savedLabel,
    answerLabel,
    noticeNode,
    footer,
    controls = new Map(),
    navigation = new Map();
  let navigationView = { current: 'q1' };
  let navigationHandle = null;
  const expanded = new Set();
  const scope = () => ({ sessionId: context.sessionId, mode: context.mode });
  const showNotice = (value) => {
    notice = value;
    if (noticeNode) {
      noticeNode.textContent = value;
      noticeNode.hidden = !value;
    }
  };
  function syncMetadata() {
    if (savedLabel)
      savedLabel.textContent = saveError
        ? '保存未确认'
        : dirty || writes.size
          ? '正在保存…'
          : '已保存';
    if (answerLabel && state?.attempt)
      answerLabel.textContent = `${countAnswers(draft)} / ${state.attempt.questions.length} 题已答`;
    for (const [id, node] of navigation) {
      node.dataset.answered = String(hasAnswer(draft[id]));
      node.dataset.marked = String(marked.includes(id));
      const verdict = state?.attempt?.grades[id]?.verdict;
      node.dataset.verdict = verdict ?? '';
      node.setAttribute(
        'aria-label',
        `第 ${id.slice(1)} 题，${verdict ? verdictNames[verdict] : hasAnswer(draft[id]) ? '已答' : '未答'}${marked.includes(id) ? '，已标记' : ''}`,
      );
    }
    if (clock && state?.attempt) {
      const remaining = Math.max(
        0,
        Math.ceil((state.attempt.deadline - (Date.now() + offset)) / 1000),
      );
      clock.textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
      clock.dataset.urgent = String(remaining <= 60);
    }
    for (const node of root.querySelectorAll('[data-model-action], [data-draft-action]'))
      node.disabled = busy;
  }
  function apply(next) {
    if (disposed) return;
    if (
      state?.attempt &&
      next.attempt &&
      state.attempt.id === next.attempt.id &&
      state.attempt.revision > next.attempt.revision
    )
      return;
    offset = next.serverNow - Date.now();
    const changedAttempt = state?.attempt?.id !== next.attempt?.id;
    state = next;
    if (changedAttempt || !dirty || next.attempt?.status !== 'answering') {
      draft = structuredClone(next.attempt?.answers ?? {});
      marked = [...(next.attempt?.marked ?? [])];
      baseRevision = next.attempt?.revision ?? 0;
      if (changedAttempt || !writes.size) reservedRevision = baseRevision;
      if (changedAttempt || next.attempt?.status !== 'answering') {
        dirty = false;
        pendingWrite = null;
        saveError = '';
      }
    }
    const key = `${next.paper?.id}:${next.paper?.status}:${next.paper?.phase}:${next.paper?.generated}:${next.paper?.repairsRemaining}:${next.attempt?.id}:${next.attempt?.status}:${Object.keys(next.attempt?.grades ?? {}).length}`;
    if (layoutKey !== key) {
      layoutKey = key;
      confirming = false;
      if (changedAttempt) {
        navigationView = { current: 'q1' };
        expanded.clear();
      }
      render(!changedAttempt);
    } else if (!dirty && !writes.size)
      for (const [id, fields] of controls) {
        for (const input of fields) {
          if (input.tagName === 'TEXTAREA' || input.type === 'text') {
            if (document.activeElement !== input && input.getRootNode().activeElement !== input)
              input.value =
                input.dataset.blankIndex === undefined
                  ? (draft[id] ?? '')
                  : (draft[id]?.[Number(input.dataset.blankIndex)] ?? '');
          } else input.checked = (draft[id] ?? []).includes(input.value);
        }
      }
    syncMetadata();
  }
  async function refresh(extra = {}) {
    if (!context.sessionId || disposed || setupMode) return null;
    const version = ++requestVersion;
    const next = await context.command('load-exam', { ...scope(), ...selection, ...extra });
    if (version === requestVersion) apply(next);
    return next;
  }
  // The same request ID is retained until a durable receipt or explicit user retry.
  async function write(input) {
    ++requestVersion;
    try {
      const next = await context.command('exam-action', { ...scope(), ...input });
      ++requestVersion;
      if (next.receipt)
        selection = {
          paperId: next.receipt.paperId,
          ...(next.receipt.attemptId ? { attemptId: next.receipt.attemptId } : {}),
        };
      apply(next);
      return next;
    } catch (error) {
      const next = await refresh({ requestId: input.requestId }).catch(() => null);
      if (next?.receipt) {
        selection = {
          paperId: next.receipt.paperId,
          ...(next.receipt.attemptId ? { attemptId: next.receipt.attemptId } : {}),
        };
        return await refresh({ requestId: input.requestId });
      }
      throw error;
    }
  }
  function enqueueSave(existing) {
    if (disposed || state?.attempt?.status !== 'answering') return;
    const version = editVersion;
    const input = existing ?? {
      action: 'save',
      requestId: crypto.randomUUID(),
      attemptId: state.attempt.id,
      expectedRevision: reservedRevision++,
      answers: structuredClone(draft),
      marked: [...marked],
    };
    // Dispatch now, before returning from the edit event. Closing the panel can
    // revoke future commands, but every committed edit is already host-owned.
    const work = write(input)
      .then((next) => {
        if (disposed || next.attempt?.id !== input.attemptId) return;
        baseRevision = Math.max(baseRevision, next.attempt.revision);
        confirmedVersion = Math.max(confirmedVersion, version);
        if (version === editVersion) {
          dirty = false;
          pendingWrite = null;
          saveError = '';
          showNotice('');
        }
      })
      .catch((error) => {
        if (disposed || state?.attempt?.status !== 'answering' || version < confirmedVersion)
          return;
        if (!pendingWrite || input.expectedRevision >= pendingWrite.expectedRevision)
          pendingWrite = input;
        saveError = messageFor(error);
        showNotice(`${saveError} 本地输入仍保留，可点击“重试保存”核对。`);
      })
      .finally(() => {
        writes.delete(work);
        if (!disposed) {
          syncMetadata();
          renderFooter();
        }
      });
    writes.add(work);
    syncMetadata();
  }
  async function flush(retry = false) {
    while (writes.size) await Promise.all([...writes]);
    if (retry && dirty && state?.attempt?.status === 'answering') {
      const recoveryVersion = editVersion;
      const localAnswers = structuredClone(draft),
        localMarked = [...marked];
      const next = await refresh(pendingWrite ? { requestId: pendingWrite.requestId } : {});
      if (next?.attempt?.status !== 'answering') return;
      // New input may have been dispatched while the receipt lookup was in flight.
      // Never restore the pre-lookup snapshot over those newer edits.
      if (editVersion !== recoveryVersion) {
        await flush();
        return;
      }
      if (
        JSON.stringify(next.attempt.answers) === JSON.stringify(localAnswers) &&
        JSON.stringify(next.attempt.marked) === JSON.stringify(localMarked)
      ) {
        dirty = false;
        saveError = '';
        pendingWrite = null;
        baseRevision = next.attempt.revision;
        reservedRevision = baseRevision;
        showNotice('');
        syncMetadata();
        renderFooter();
        return;
      }
      draft = localAnswers;
      marked = localMarked;
      baseRevision = next.attempt.revision;
      reservedRevision = baseRevision;
      const same =
        pendingWrite &&
        pendingWrite.expectedRevision === baseRevision &&
        JSON.stringify(pendingWrite.answers) === JSON.stringify(draft) &&
        JSON.stringify(pendingWrite.marked) === JSON.stringify(marked);
      const original = same ? pendingWrite : null;
      saveError = '';
      if (original) reservedRevision++;
      enqueueSave(original);
      while (writes.size) await Promise.all([...writes]);
    }
    if (dirty || saveError) throw new Error(saveError || '答案尚未确认保存');
  }
  function edited() {
    dirty = true;
    editVersion++;
    enqueueSave();
  }
  async function model(tool, message) {
    try {
      if (dirty) await flush();
      const accepted = await context.startRun(tool, message);
      if (!accepted) showNotice('当前对话正在运行，请稍后再试。');
      else setupMode = false;
    } catch (error) {
      showNotice(messageFor(error));
    }
  }
  function modelButton(text, tool, message) {
    const node = button(
      text,
      () => void model(tool, message),
      tool === 'review' ? 'exam-explain' : 'exam-primary',
    );
    node.dataset.modelAction = '';
    node.disabled = busy;
    return node;
  }
  function render(preserve = false) {
    const oldContent = root.querySelector('.exam-content');
    const scrollTop = preserve ? (oldContent?.scrollTop ?? 0) : 0;
    const oldTop = oldContent?.getBoundingClientRect().top ?? 0;
    const anchor = preserve
      ? [...(oldContent?.querySelectorAll('[data-read-anchor]') ?? [])].findLast(
          (node) => node.getBoundingClientRect().top <= oldTop + 24,
        )
      : null;
    const anchorKey = anchor?.dataset.readAnchor;
    const anchorOffset = anchor ? anchor.getBoundingClientRect().top - oldTop : 0;
    const focused = root.getRootNode().activeElement;
    const focusedQuestion = preserve ? focused?.closest('[data-question]')?.dataset.question : null;
    const focusedSummary = focused?.tagName === 'SUMMARY';
    const focusedNav = preserve ? focused?.dataset.navQuestion : null;
    navigationHandle?.cleanup();
    navigationHandle = null;
    controls = new Map();
    navigation = new Map();
    clock = null;
    savedLabel = null;
    answerLabel = null;
    footer = null;
    root.replaceChildren();
    const header = el('header', 'exam-header');
    const titleRow = el('div', 'exam-title-row');
    titleRow.append(el('h2', '', state?.paper?.title ?? '学习试卷'));
    if ((state?.papers.length ?? 0) > 1 || (state?.attempts.length ?? 0) > 1) {
      const history = el('details', 'exam-history');
      const summary = el('summary', '', '历史');
      summary.prepend(icon('history'));
      summary.setAttribute('aria-label', '试卷与作答记录');
      history.append(summary);
      const list = el('div', 'exam-history-list');
      for (const paper of state.papers) {
        const attempts = state.attempts.filter((a) => a.paperId === paper.id);
        for (const item of attempts.length ? attempts : [null]) {
          const selected =
            paper.id === state.paper?.id && (item?.id ?? null) === (state.attempt?.id ?? null);
          const choice = button(
            `${paper.title}${item ? ` · ${new Date(item.startedAt).toLocaleString()}${item.status === 'answering' ? ' · 作答中' : ''}` : ' · 待开考'}`,
            async () => {
              try {
                await flush();
                selection = { paperId: paper.id, ...(item ? { attemptId: item.id } : {}) };
                history.open = false;
                await refresh();
              } catch {
                showNotice('请先完成当前答案保存，再切换试卷。');
              }
            },
          );
          choice.setAttribute('aria-current', String(selected));
          list.append(choice);
        }
      }
      history.append(list);
      header.append(history);
    }
    header.append(titleRow);
    if (state?.paper)
      header.append(
        el(
          'p',
          'exam-meta',
          `${state.paper.questionCount} 题 · ${state.paper.durationMinutes} 分钟 · 100 分 · ${state.paper.difficulty}`,
        ),
      );
    noticeNode = el('p', 'exam-notice', notice);
    noticeNode.setAttribute('role', 'status');
    noticeNode.hidden = !notice;
    header.append(noticeNode);
    root.append(header);
    const content = el('div', 'exam-content');
    const body = el('div', 'exam-body');
    body.append(content);
    root.append(body);
    if (!state?.paper) {
      const stage = el('div', 'exam-stage exam-welcome');
      content.append(stage);
      renderSetup(stage);
      return;
    }
    if (state.paper.status !== 'ready') {
      const stage = el('div', 'exam-stage');
      content.append(stage);
      renderPreparing(stage);
      return;
    }
    if (!state.attempt) {
      const stage = el('div', 'exam-stage exam-ready');
      content.append(stage);
      const symbol = el('div', 'exam-stage-symbol');
      symbol.append(icon('check'));
      stage.append(symbol);
      stage.append(
        el('h3', '', '试卷已准备好'),
        el('p', 'exam-description', '整卷已完成复核。点击开始后计时，离开面板或关闭应用不会暂停。'),
      );
      const topics = el('ul', 'exam-topics');
      for (const topic of [...new Set(state.paper.topics)]) topics.append(el('li', '', topic));
      stage.append(topics);
      renderPlan(stage);
      const start = button(
        '开始考试',
        async () => {
          start.disabled = true;
          try {
            await write({
              action: 'start',
              paperId: state.paper.id,
              requestId: crypto.randomUUID(),
            });
          } catch (error) {
            showNotice(messageFor(error));
            start.disabled = false;
          }
        },
        'exam-primary',
      );
      stage.append(start);
      return;
    }
    const attempt = state.attempt;
    root.dataset.status = attempt.status;
    if (attempt.status === 'answering') {
      const status = el('div', 'exam-statusbar');
      clock = el('time', 'exam-clock');
      clock.setAttribute('aria-label', '剩余考试时间');
      answerLabel = el('span');
      savedLabel = el('span', 'exam-save');
      savedLabel.setAttribute('role', 'status');
      status.append(clock, answerLabel, savedLabel);
      header.append(status);
    } else {
      const result = el('div', 'exam-result');
      result.append(
        el(
          'h3',
          '',
          attempt.status === 'graded'
            ? attempt.score === null
              ? `${attempt.confirmedScore} 分已确认 · ${attempt.uncertain} 题待复核`
              : `${attempt.score} / 100 分`
            : attempt.status === 'grading'
              ? '正在批改'
              : '已交卷',
        ),
      );
      result.append(
        el(
          'p',
          'exam-description',
          attempt.status === 'graded'
            ? '逐题查看评分依据，也可以回到对话继续讨论。'
            : attempt.submitReason === 'timeout'
              ? '考试时间已到，已封存最后保存的答案。'
              : '作答已封存，答案不会再改变。',
        ),
      );
      if (attempt.error)
        result.append(
          el('p', 'exam-notice', errors[attempt.error] ?? '批改未完成，已保留你的作答。'),
        );
      if (attempt.status === 'submitted')
        result.append(
          modelButton(
            Object.keys(attempt.grades).length ? '继续批改' : '批改试卷',
            'grade',
            `请批改《${state.paper.title}》中尚未完成批改的题目。作答编号：${attempt.id}`,
          ),
        );
      if (attempt.status === 'grading')
        result.append(
          el(
            'p',
            'exam-meta',
            `已批改 ${Object.keys(attempt.grades).length} / ${attempt.questions.length} 题`,
          ),
        );
      content.append(result);
    }
    navigationHandle = mountNavigation({
      root,
      body,
      content,
      titleRow,
      questions: attempt.questions,
      view: navigationView,
      el,
      button,
    });
    navigation = navigationHandle.nodes;
    if (attempt.status !== 'answering')
      navigationHandle.legend.textContent = '✓ 正确 · − 未得分\n◐ 部分得分 · ? 待复核';
    const groups = sections(attempt.questions);
    for (const question of attempt.questions) {
      const group = groups.find((s) => s.start === question.id);
      if (group)
        content.append(
          el(
            'h3',
            'exam-section-title',
            `${typeNames[group.type]}题 · ${group.count} 题 · ${group.points} 分`,
          ),
        );
      renderQuestion(content, question, attempt);
    }
    footer = el('footer', 'exam-footer');
    root.append(footer);
    renderFooter();
    syncMetadata();
    content.scrollTop = scrollTop;
    if (anchorKey) {
      const restored = content.querySelector(`[data-read-anchor="${anchorKey}"]`);
      if (restored)
        content.scrollTop +=
          restored.getBoundingClientRect().top - content.getBoundingClientRect().top - anchorOffset;
    }
    if (focusedNav) navigation.get(focusedNav)?.focus({ preventScroll: true });
    else if (focusedQuestion && focusedSummary)
      content
        .querySelector(`[data-question="${focusedQuestion}"] summary`)
        ?.focus({ preventScroll: true });
  }
  function insertExamPrompt() {
    if (typeof context.insertPrompt !== 'function') {
      showNotice('请更新 LimeA 主程序，以使用输入框试卷提示。');
      return;
    }
    const accepted = context.insertPrompt({
      label: '试卷',
      content:
        '请根据当前学习进度，使用学习试卷插件制作一份计时模拟试卷，不使用抽查工具。优先遵从我补充的范围、题量、时长、难度和题型；未指定时默认10题、30分钟、适中难度。先确定题型与分值，逐题编写，整卷审核后再让我开始考试。若学习依据不足，先向我确认。',
    });
    showNotice(accepted ? '' : '未能加入输入框，请检查当前草稿或稍后重试。');
  }
  function renderSetup(content) {
    const symbol = el('div', 'exam-stage-symbol');
    symbol.append(icon('paper'));
    content.append(
      symbol,
      el('h3', '', '把学过的，认真考一次'),
      el('p', 'exam-description', '在对话中说明考试范围与要求。试卷准备好后，在这里专心作答。'),
    );
    const create = button('试卷', insertExamPrompt, 'exam-primary exam-create');
    create.prepend(icon('paper'));
    create.dataset.draftAction = '';
    content.append(create, el('p', 'exam-meta', '加入输入框 · 补充要求后发送'));
    syncMetadata();
  }
  function renderPlan(content) {
    if (!state.paper.sections?.length) return;
    const plan = el('div', 'exam-plan');
    plan.append(el('p', 'exam-eyebrow', '试卷结构'));
    for (const section of state.paper.sections) {
      const row = el('div', 'exam-plan-row');
      row.append(
        el('span', '', `${typeNames[section.type]}题`),
        el('span', 'exam-meta', `${section.count} 题`),
        el('span', '', `${section.points} 分`),
      );
      plan.append(row);
    }
    content.append(plan);
  }
  function renderPreparing(content) {
    const p = state.paper;
    const stage = p.phase === 'blueprint' ? 0 : p.generated < p.questionCount ? 1 : 2;
    const steps = el('ol', 'exam-steps');
    for (const [index, label] of ['规划结构', '编写题目', '整卷审核'].entries()) {
      const item = el('li');
      item.dataset.state = index < stage ? 'done' : index === stage ? 'current' : 'pending';
      if (index === stage) item.setAttribute('aria-current', 'step');
      const marker = el('span', 'exam-step-marker', index < stage ? '' : String(index + 1));
      if (index < stage) marker.append(icon('check'));
      item.append(marker, el('span', '', label));
      steps.append(item);
    }
    content.append(steps);
    content.append(
      el('h3', '', p.status === 'paused' ? '出卷已暂停' : (phaseNames[p.phase] ?? '正在准备试卷')),
      el('p', 'exam-progress', `已生成 ${p.generated} / ${p.questionCount} 题`),
    );
    const progress = el('progress');
    progress.max = p.questionCount;
    progress.value = p.generated;
    progress.setAttribute('aria-label', '已生成题目');
    content.append(progress);
    content.append(
      el(
        'p',
        'exam-description',
        p.status === 'paused'
          ? (errors[p.error] ?? '已完成的题目已保存，可以继续。')
          : p.phase === 'repair'
            ? `只修订问题题目，剩余 ${p.repairsRemaining} 题。修订后复核一次。`
            : '题目生成完成后，统一审核答案与整卷一致性。现在还未开始计时。',
      ),
    );
    if (p.status === 'paused' && p.issues?.length) {
      const issues = el('ul', 'exam-issues');
      for (const issue of p.issues)
        issues.append(
          el(
            'li',
            '',
            `第 ${issue.questionIds.map((id) => id.slice(1)).join('、')} 题：${issueNames[issue.category]}`,
          ),
        );
      content.append(issues);
    }
    if (p.formatQuestion)
      content.append(el('p', 'exam-notice', `第 ${p.formatQuestion.slice(1)} 题格式需修订。`));
    renderPlan(content);
    const range = el('details', 'exam-scope');
    range.append(el('summary', '', '本次学习范围'), el('p', 'exam-description', p.learningContext));
    content.append(range);
    if (p.status === 'paused')
      content.append(
        modelButton(
          p.stage === 'blocked' ? '再尝试一轮修订' : '继续出卷',
          'prepare',
          `请继续制作《${p.title}》，保留已完成内容；若上轮修订仍未通过，请只再尝试一轮定向修订。试卷编号：${p.id}`,
        ),
      );
    else
      content.append(
        button('暂停出卷', async () => {
          try {
            await write({ action: 'pause', paperId: p.id, requestId: crypto.randomUUID() });
          } catch (error) {
            showNotice(messageFor(error));
          }
        }),
      );
  }
  function renderQuestion(content, q, attempt) {
    const article = el('article', 'exam-question');
    article.dataset.question = q.id;
    article.dataset.readAnchor = q.id;
    const heading = el('div', 'exam-question-heading');
    const title = el('h3', '', `${q.id.slice(1)}. ${typeNames[q.type]}`);
    title.tabIndex = -1;
    heading.dataset.readAnchor = `${q.id}-heading`;
    heading.append(title, el('span', 'exam-meta', `${q.points} 分`));
    if (attempt.status === 'answering') {
      const mark = button(
        marked.includes(q.id) ? '已标记' : '标记待检查',
        () => {
          marked = marked.includes(q.id) ? marked.filter((v) => v !== q.id) : [...marked, q.id];
          mark.textContent = marked.includes(q.id) ? '已标记' : '标记待检查';
          mark.setAttribute('aria-pressed', String(marked.includes(q.id)));
          edited();
        },
        'exam-mark',
      );
      mark.setAttribute('aria-pressed', String(marked.includes(q.id)));
      heading.append(mark);
    }
    article.append(
      heading,
      math(q.type === 'fill' ? q.stem.replace(/\[\[b(\d+)\]\]/g, '（第$1空）____') : q.stem),
    );
    if (attempt.status === 'answering') {
      const fields = [];
      if (q.type === 'short') {
        const input = el('textarea', 'exam-answer');
        input.rows = 5;
        input.maxLength = 4000;
        input.value = draft[q.id] ?? '';
        input.setAttribute('aria-label', `第${q.id.slice(1)}题作答`);
        input.addEventListener('input', (event) => {
          draft[q.id] = input.value;
          if (!event.isComposing) edited();
        });
        input.addEventListener('compositionend', () => {
          draft[q.id] = input.value;
          edited();
        });
        article.append(input);
        fields.push(input);
      } else if (q.type === 'fill') {
        for (const [index, blank] of q.blanks.entries()) {
          const label = el('label', 'exam-field exam-blank');
          const input = el('input');
          input.type = 'text';
          input.maxLength = 1000;
          input.dataset.blankIndex = String(index);
          input.value = draft[q.id]?.[index] ?? '';
          input.setAttribute('aria-label', `第${q.id.slice(1)}题第${index + 1}空`);
          const capture = () => {
            draft[q.id] = q.blanks.map((_, i) => fields[i]?.value ?? '');
          };
          input.addEventListener('input', (event) => {
            capture();
            if (!event.isComposing) edited();
          });
          input.addEventListener('compositionend', () => {
            capture();
            edited();
          });
          label.append(el('span', 'exam-meta', `第 ${index + 1} 空 · ${blank.points} 分`), input);
          article.append(label);
          fields.push(input);
        }
      } else {
        const choices = el('fieldset', 'exam-choices');
        const legend = el('legend', 'exam-sr-only', `第${q.id.slice(1)}题选项`);
        choices.append(legend);
        for (const option of q.options) {
          const label = el('label', 'exam-option'),
            input = el('input');
          input.type = q.type === 'multiple' ? 'checkbox' : 'radio';
          input.name = `${attempt.id}-${q.id}`;
          input.value = option.id;
          input.checked = (draft[q.id] ?? []).includes(option.id);
          input.addEventListener('change', () => {
            draft[q.id] =
              q.type !== 'multiple'
                ? [option.id]
                : fields.filter((v) => v.checked).map((v) => v.value);
            edited();
          });
          label.append(input, el('span', 'exam-option-id', option.id), math(option.text));
          choices.append(label);
          fields.push(input);
        }
        article.append(choices);
      }
      controls.set(q.id, fields);
    } else {
      if (q.options.length)
        for (const option of q.options) article.append(math(`${option.id}. ${option.text}`));
      const answer = attempt.answers[q.id];
      article.append(
        el('p', 'exam-answer-label', '你的作答'),
        math(
          q.type === 'fill'
            ? q.blanks.map((_, i) => `第${i + 1}空：${answer?.[i] || '未作答'}`).join('\n')
            : q.type === 'judge'
              ? (q.options.find((o) => o.id === answer?.[0])?.text ?? '未作答')
              : Array.isArray(answer)
                ? answer.join('、') || '未作答'
                : answer || '未作答',
        ),
      );
      const grade = attempt.grades[q.id];
      if (grade) {
        const verdict = el(
          'p',
          'exam-verdict',
          `${verdictNames[grade.verdict]}${grade.score === null ? '' : ` · ${grade.score} / ${q.points} 分`}`,
        );
        verdict.dataset.verdict = grade.verdict;
        article.append(verdict, math(grade.explanation));
      }
      const details = el('details', 'exam-explanation');
      details.dataset.readAnchor = `${q.id}-reference`;
      details.open = expanded.has(q.id);
      details.addEventListener('toggle', () => {
        if (details.isConnected) {
          if (details.open) expanded.add(q.id);
          else expanded.delete(q.id);
        }
      });
      details.append(
        el('summary', '', '参考答案与解析'),
        math(
          q.correctOptions.length
            ? `${q.correctOptions.join('、')}：${q.referenceAnswer}`
            : q.referenceAnswer,
        ),
        math(q.explanation),
        el('p', 'exam-meta', `评分标准：${q.rubric}`),
      );
      article.append(details);
      article.append(
        modelButton(
          '讲解这道题',
          'review',
          `请结合我的作答，讲解《${state.paper.title}》第${q.id.slice(1)}题的解题过程和失分原因。作答编号：${attempt.id}，题号：${q.id}`,
        ),
      );
    }
    let proseIndex = 0;
    for (const node of article.children) {
      if (
        node.classList.contains('exam-prose') &&
        !node.previousElementSibling?.classList.contains('exam-verdict')
      )
        node.dataset.readAnchor = `${q.id}-prose-${proseIndex++}`;
    }
    content.append(article);
  }
  function renderFooter() {
    if (!footer || !state?.attempt) return;
    footer.replaceChildren();
    if (state.attempt.status === 'answering') {
      if (saveError)
        footer.append(
          button('重试保存', () => {
            void flush(true).catch(() => {});
          }),
        );
      if (confirming) {
        const missing = state.attempt.questions.length - countAnswers(draft);
        footer.append(
          el(
            'p',
            '',
            missing ? `还有 ${missing} 题未作答。交卷后不能修改。` : '交卷后不能修改作答。',
          ),
        );
        footer.append(
          button(
            '确认交卷',
            async () => {
              try {
                await flush();
                if (state.attempt.status !== 'answering') return;
                await write({
                  action: 'submit',
                  requestId: crypto.randomUUID(),
                  attemptId: state.attempt.id,
                  expectedRevision: baseRevision,
                });
              } catch (error) {
                showNotice(messageFor(error));
              }
            },
            'exam-primary',
          ),
          button('继续作答', () => {
            confirming = false;
            renderFooter();
          }),
        );
      } else
        footer.append(
          button(
            '检查并交卷',
            () => {
              confirming = true;
              renderFooter();
            },
            'exam-primary',
          ),
        );
    } else if (state.attempt.status === 'graded') {
      footer.append(
        button('再做一次', async () => {
          try {
            await write({
              action: 'start',
              paperId: state.paper.id,
              requestId: crypto.randomUUID(),
            });
          } catch (error) {
            showNotice(messageFor(error));
          }
        }),
      );
      footer.append(button('制作新试卷', insertExamPrompt));
    }
  }
  const unsubscribeVisibility = context.onVisibilityChange((value) => {
    visible = value;
    if (value) void refresh().catch((e) => showNotice(messageFor(e)));
  });
  const unsubscribeRun = context.onRunStateChange((value) => {
    busy = value;
    syncMetadata();
  });
  render();
  const poll = setInterval(() => {
    if (visible && !disposed) void refresh().catch((e) => showNotice(messageFor(e)));
  }, 1500);
  const tick = setInterval(syncMetadata, 250);
  return () => {
    disposed = true;
    navigationHandle?.cleanup();
    clearInterval(poll);
    clearInterval(tick);
    unsubscribeVisibility();
    unsubscribeRun();
    root.remove();
    style.remove();
    mathStyle.remove();
  };
}
