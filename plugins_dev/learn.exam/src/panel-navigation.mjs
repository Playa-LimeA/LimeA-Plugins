import { typeNames, sections } from './question-types.mjs';

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const paths = {
    paper: [
      'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z',
      'M14 3v6h6',
      'M8 13h8M8 17h5',
    ],
    grid: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
    close: ['m6 6 12 12M6 18 18 6'],
    check: ['m5 12 4 4L19 6'],
    history: ['M3 11a9 9 0 1 1 2.6 7.4M3 5v6h6', 'M12 7v5l3 2'],
  };
  for (const d of paths[name] ?? paths.paper) {
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** 只拥有导航视图；不改答案、计时或提交状态。 */
export function mountNavigation({ root, body, content, titleRow, questions, view, el, button }) {
  const nav = el('aside', 'exam-nav');
  nav.id = `exam-nav-${crypto.randomUUID()}`;
  nav.setAttribute('aria-label', '试卷题号导航');
  const title = el('div', 'exam-nav-title');
  title.append(el('h3', '', '答题卡'));
  const toggle = button('答题卡', () => setOpen(!isOpen()), 'exam-nav-toggle');
  toggle.prepend(icon('grid'));
  toggle.setAttribute('aria-controls', nav.id);
  const close = button(
    '关闭答题卡',
    () => {
      setOpen(false);
      toggle.focus();
    },
    'exam-icon-button exam-nav-close',
  );
  close.replaceChildren(icon('close'));
  close.setAttribute('aria-label', '关闭答题卡');
  title.append(close);
  nav.append(title);
  const nodes = new Map();
  for (const group of sections(questions)) {
    const section = el('section', 'exam-nav-group');
    section.append(el('p', 'exam-meta', `${typeNames[group.type]}题`));
    const grid = el('div', 'exam-number-grid');
    for (const q of questions.slice(
      questions.findIndex((q) => q.id === group.start),
      questions.findIndex((q) => q.id === group.start) + group.count,
    )) {
      const jump = button(q.id.slice(1), () => {
        const article = content.querySelector(`[data-question="${q.id}"]`);
        if (!article) return;
        content.scrollTo({
          top:
            article.getBoundingClientRect().top -
            content.getBoundingClientRect().top +
            content.scrollTop -
            20,
        });
        view.current = q.id;
        if (narrow) setOpen(false);
        article.querySelector('h3').focus({ preventScroll: true });
        updateCurrent();
      });
      jump.dataset.navQuestion = q.id;
      grid.append(jump);
      nodes.set(q.id, jump);
    }
    section.append(grid);
    nav.append(section);
  }
  const legend = el('p', 'exam-nav-legend', '填色 已答 · 圆点 标记\n边框 当前题');
  nav.append(legend);
  body.append(nav);
  titleRow.append(toggle);
  let narrow = root.getBoundingClientRect().width < 720;
  const isOpen = () => view.open ?? !narrow;
  function syncOpen() {
    root.dataset.narrow = String(narrow);
    root.dataset.navOpen = String(isOpen());
    nav.hidden = !isOpen();
    toggle.setAttribute('aria-expanded', String(isOpen()));
  }
  function setOpen(open) {
    view.open = open;
    syncOpen();
  }
  function updateCurrent() {
    for (const [id, node] of nodes) {
      node.dataset.current = String(id === view.current);
      if (id === view.current) node.setAttribute('aria-current', 'true');
      else node.removeAttribute('aria-current');
    }
  }
  function onScroll() {
    const top = content.getBoundingClientRect().top + 70;
    const articles = [...content.querySelectorAll('[data-question]')];
    view.current = (
      articles.findLast((article) => article.getBoundingClientRect().top <= top) ?? articles[0]
    )?.dataset.question;
    updateCurrent();
  }
  const resize = new ResizeObserver(() => {
    narrow = root.getBoundingClientRect().width < 720;
    syncOpen();
  });
  resize.observe(root);
  content.addEventListener('scroll', onScroll, { passive: true });
  const escape = (event) => {
    if (event.key === 'Escape' && isOpen() && narrow) {
      event.stopPropagation();
      setOpen(false);
      toggle.focus();
    }
  };
  root.addEventListener('keydown', escape);
  syncOpen();
  updateCurrent();
  return {
    nodes,
    legend,
    cleanup() {
      resize.disconnect();
      content.removeEventListener('scroll', onScroll);
      root.removeEventListener('keydown', escape);
    },
  };
}
