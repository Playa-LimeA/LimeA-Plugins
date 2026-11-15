import css from './page.css';
import { zh, en } from './page-strings.mjs';

export function mount(container, context) {
  if (context.signal.aborted) return;
  const t = context.language.startsWith('zh') ? zh : en;
  const style = document.createElement('style');
  style.textContent = css;
  const root = document.createElement('div');
  root.className = 'exam-page';
  root.innerHTML = `
    <section class="intro" aria-label=""><ul></ul></section>
    <section class="features" aria-labelledby="exam-features-title">
      <h2 id="exam-features-title"><span class="section-icon" data-icon="blocks"></span><span class="heading-label"></span><span class="section-count"></span></h2>
      <ul></ul>
    </section>
    <section class="usage" aria-labelledby="exam-usage-title">
      <h2 id="exam-usage-title"><span class="section-icon" data-icon="message-square"></span><span class="heading-label"></span></h2>
      <p></p><blockquote></blockquote>
    </section>`;
  container.replaceChildren(style, root);
  const query = (selector) => root.querySelector(selector);
  query('.intro').setAttribute('aria-label', t.introLabel);
  for (const [title, detail] of t.intro) {
    const item = document.createElement('li');
    const heading = document.createElement('strong');
    heading.textContent = title;
    const copy = document.createElement('span');
    copy.textContent = detail;
    item.append(heading, copy);
    query('.intro ul').append(item);
  }
  for (const { icon, title, detail } of t.features) {
    const item = document.createElement('li');
    const slot = document.createElement('span');
    slot.className = 'feature-icon';
    slot.dataset.icon = icon;
    const copy = document.createElement('div');
    const heading = document.createElement('h3');
    heading.textContent = title;
    const description = document.createElement('p');
    description.textContent = detail;
    copy.append(heading, description);
    item.append(slot, copy);
    query('.features ul').append(item);
  }
  query('.features .heading-label').textContent = t.featuresTitle;
  query('.section-count').textContent = String(t.features.length);
  query('.usage .heading-label').textContent = t.usageTitle;
  query('.usage p').textContent = t.usage;
  query('.usage blockquote').textContent = t.example;
  const handles = [];
  for (const slot of root.querySelectorAll('[data-icon]')) {
    const name = slot.dataset.icon;
    if (context.controls?.icons?.includes(name))
      handles.push(context.controls.mount(slot, { type: 'icon', name, size: 18 }));
    else slot.hidden = true;
  }
  let disposed = false;
  function cleanup() {
    if (disposed) return;
    disposed = true;
    context.signal.removeEventListener('abort', cleanup);
    for (const handle of handles) handle.destroy();
    root.remove();
    style.remove();
  }
  context.signal.addEventListener('abort', cleanup, { once: true });
  return cleanup;
}
