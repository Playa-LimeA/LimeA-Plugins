import { locations } from './locations.mjs';
import { activityCatalog, isTownState } from './town-state.mjs';
import { makeViewer } from './viewer.mjs';

const refreshInterval = 200;
const preview = { scene: 'home', point: locations.home.visit, activity: 'idle', paused: false };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function validSnapshot(state) {
  if (
    !isTownState(state) ||
    typeof state.paused !== 'boolean' ||
    !Number.isSafeInteger(state.updatedAt)
  ) {
    return false;
  }
  if (state.motion === undefined) return true;
  const { from, to, startsAt, endsAt } = state.motion ?? {};
  return (
    typeof from === 'string' &&
    typeof to === 'string' &&
    Number.isSafeInteger(startsAt) &&
    Number.isSafeInteger(endsAt) &&
    endsAt > startsAt
  );
}

const text = {
  zh: {
    title: '陪伴小镇',
    loading: '正在打开小镇',
    reset: '重置视角',
    retry: '重试',
    pause: '暂停',
    resume: '继续',
    route: (place) => `正在前往${place}`,
    walking: '正在散步',
    walkingAtHome: '正在家里走动',
    crossing: '正在过街',
    resting: '在家歇一会儿',
    arrived: (place) => `已到达${place}`,
    stopped: (place) => `现在在${place}`,
    selectCharacter: '选一个角色，就能看到对方在小镇的生活。',
    notResident: '当前角色尚未入住。可以在陪伴小镇的插件详情页选择入住角色。',
    paused: (description) => `已暂停 · ${description}`,
    identityUnavailable: '此版本的 LimeA 无法连接角色的小镇生活。',
    restoreFailed: '暂时无法读取角色的小镇状态，可以重试。',
    failed: (place) => `${place}暂时无法打开，可以重试。`,
    graphics: '三维画面无法启动。请在支持硬件加速的窗口中重试。',
  },
  en: {
    title: 'Companion Town',
    loading: 'Opening town',
    reset: 'Reset view',
    retry: 'Try again',
    pause: 'Pause',
    resume: 'Resume',
    route: (place) => `Walking to ${place}`,
    walking: 'Taking a walk',
    walkingAtHome: 'Walking around at home',
    crossing: 'Crossing the street',
    resting: 'Resting at home',
    arrived: (place) => `Arrived at ${place}`,
    stopped: (place) => `Currently at ${place}`,
    selectCharacter: 'Choose a character to see how they spend time in town.',
    notResident: 'This character has not moved in. Choose residents on the Companion Town plugin page.',
    paused: (description) => `Paused · ${description}`,
    identityUnavailable: 'This version of LimeA cannot connect characters to town.',
    restoreFailed: 'Could not read this character’s town activity. Try again.',
    failed: (place) => `Could not open ${place}. Try again.`,
    graphics: 'The 3D view could not start. Try again in a window with graphics acceleration.',
  },
};

export function mount(container, context) {
  const language = context.language.startsWith('zh') ? 'zh' : 'en';
  const words = text[language];
  const name = (id) => locations[id].name[language];

  const styles = element('link');
  styles.rel = 'stylesheet';
  styles.href = new URL('town.css', context.resourceBase).href;
  const root = element('section', 'town');
  const header = element('header', 'town-header');
  const locationTitle = element('h2', 'town-location', words.title);
  const reset = element('button', 'town-reset', words.reset);
  reset.type = 'button';
  reset.disabled = true;
  header.append(locationTitle, reset);

  const viewport = element('div', 'town-viewport');
  viewport.dataset.testid = 'town-viewport';
  viewport.hidden = true;

  const footer = element('footer', 'town-footer');
  const statusRow = element('div', 'town-status-row');
  const status = element('p', 'town-status', words.loading);
  status.dataset.townStatus = '';
  status.setAttribute('role', 'status');
  const retry = element('button', 'town-retry', words.retry);
  retry.type = 'button';
  retry.hidden = true;
  const toggle = element('button', 'town-toggle', words.pause);
  toggle.type = 'button';
  toggle.dataset.townToggle = '';
  toggle.disabled = true;
  statusRow.append(status, retry, toggle);
  footer.append(statusRow);
  root.append(viewport, header, footer);
  root.dataset.travelling = 'false';
  root.dataset.activity = 'idle';
  root.dataset.paused = 'false';
  container.replaceChildren(styles, root);

  let viewer;
  let shownScene;
  let observation;
  let visible = false;
  let identityAvailable = false;
  let characterId = null;
  let latest;

  function statusText(message) {
    if (status.textContent !== message) status.textContent = message;
  }

  function updateControls(pending = false) {
    reset.disabled = viewport.hidden || !shownScene;
    toggle.disabled = !latest || pending;
    toggle.textContent = latest?.paused ? words.resume : words.pause;
  }

  function label(state) {
    if (state.activity === 'crossing') return words.crossing;
    if (Object.hasOwn(activityCatalog, state.activity)) {
      return activityCatalog[state.activity].name[language];
    }
    if (state.activity === 'walking') {
      if (state.scene === 'home' && state.destination === 'home') return words.walkingAtHome;
      return state.destination ? words.route(name(state.destination)) : words.walking;
    }
    if (state.scene === 'home' && state.point === locations.home.visit) return words.resting;
    if (state.point === locations[state.scene].visit) return words.arrived(name(state.scene));
    return words.stopped(name(state.scene));
  }

  function stopObserving() {
    if (!observation) return;
    clearTimeout(observation.timer);
    observation.controller.abort();
    observation = undefined;
  }

  async function refresh(watch, paused) {
    const { owner, signal } = watch;
    let failure = words.restoreFailed;
    try {
      let resident = null;
      if (owner) {
        resident =
          paused === undefined
            ? await context.command('read-town-view', { characterId: owner })
            : await context.command('set-town-paused', { characterId: owner, paused });
        signal.throwIfAborted();
        if (resident !== null && !validSnapshot(resident)) throw new Error('Invalid town snapshot');
      }
      const state = resident ?? preview;

      if (!viewer) {
        failure = words.graphics;
        viewer = makeViewer(viewport, { header, footer }, context);
      }

      failure = words.failed(name(state.scene));
      if (shownScene !== state.scene) {
        const model = await viewer.load(state.scene, signal);
        viewer.show(model, state.point, signal, { showVisitor: Boolean(resident) });
        shownScene = state.scene;
      }
      signal.throwIfAborted();
      viewer.setVisitorVisible(Boolean(resident));
      const motion = state.paused ? undefined : state.motion;
      viewer.place(state.point, motion);
      if (viewport.hidden) {
        viewport.hidden = false;
        viewer.setVisible(true);
      }

      latest = resident ?? undefined;
      root.dataset.resident = String(Boolean(resident));
      root.dataset.scene = state.scene;
      root.dataset.point = state.point;
      root.dataset.activity = state.activity;
      root.dataset.paused = String(state.paused);
      root.dataset.travelling = String(Boolean(motion && motion.endsAt > Date.now()));
      locationTitle.textContent = name(state.scene);
      const currentLabel = label(state);
      statusText(
        resident
          ? state.paused ? words.paused(currentLabel) : currentLabel
          : owner ? words.notResident : identityAvailable ? words.selectCharacter : words.identityUnavailable,
      );
      updateControls();

      if (owner) watch.timer = setTimeout(() => void refresh(watch), resident ? refreshInterval : 1000);
    } catch (error) {
      if (signal.aborted) return;
      console.warn('Companion Town:', error);
      retry.hidden = false;
      statusText(failure);
      updateControls(true);
    }
  }

  function observe(paused) {
    stopObserving();
    if (!visible || context.signal.aborted) return;
    retry.hidden = true;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, context.signal]);
    observation = { owner: characterId, controller, signal, timer: undefined };
    updateControls(true);
    void refresh(observation, paused);
  }

  function stopDrawing() {
    viewport.hidden = true;
    viewer?.setVisible(false);
  }

  const unsubscribeCharacter = context.onCharacterChange?.(({ characterId: selected }) => {
    const canIdentify = selected !== undefined;
    const next = typeof selected === 'string' && selected.trim() ? selected : null;
    if (next === characterId && canIdentify === identityAvailable) return;
    stopObserving();
    stopDrawing();
    identityAvailable = canIdentify;
    characterId = next;
    shownScene = undefined;
    latest = undefined;
    viewer?.clear();
    delete root.dataset.scene;
    delete root.dataset.point;
    root.dataset.activity = 'idle';
    root.dataset.resident = 'false';
    root.dataset.paused = 'false';
    root.dataset.travelling = 'false';
    statusText(words.loading);
    observe();
  });

  const unsubscribeVisible = context.onVisibilityChange((next) => {
    if (next === visible) return;
    visible = next;
    if (visible) {
      statusText(words.loading);
      observe();
    } else {
      stopObserving();
      stopDrawing();
    }
  });

  reset.addEventListener('click', () => viewer?.resetView());
  retry.addEventListener('click', () => observe());
  toggle.addEventListener('click', () => {
    if (latest) observe(!latest.paused);
  });

  return () => {
    visible = false;
    stopObserving();
    unsubscribeVisible?.();
    unsubscribeCharacter?.();
    viewer?.dispose();
    container.replaceChildren();
  };
}
