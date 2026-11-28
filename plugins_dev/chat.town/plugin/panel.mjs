import { locations } from './locations.mjs';
import { createTownMap } from './town-map.mjs';
import { makeTownStatusCard, townArea } from './town-status-card.mjs';
import { activityCatalog, isTownState } from './town-state.mjs';
import { makeViewer } from './viewer.mjs';

const refreshInterval = 200;
const activityPhase = {
  walking: 'moving',
  crossing: 'moving',
  sleeping: 'resting',
  resting_sofa: 'resting',
  idle: 'staying',
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function validMotion(scene, point, motion) {
  if (motion === undefined) return true;
  const { from, to, startsAt, endsAt } = motion ?? {};
  return (
    from === point &&
    isTownState({ scene, point: to, activity: 'idle' }) &&
    Number.isSafeInteger(startsAt) &&
    Number.isSafeInteger(endsAt) &&
    endsAt > startsAt
  );
}

function validIdentity(character) {
  return typeof character?.characterId === 'string' && character.characterId.length > 0 &&
    typeof character.name === 'string';
}

function validSnapshot(state) {
  return isTownState(state) &&
    typeof state.paused === 'boolean' &&
    Number.isSafeInteger(state.updatedAt) &&
    (state.residence === undefined || validIdentity(state.residence)) &&
    (state.destinationResidence === undefined || validIdentity(state.destinationResidence)) &&
    validMotion(state.scene, state.point, state.motion);
}

function validWindow(town) {
  return typeof town?.scene === 'string' && Object.hasOwn(locations, town.scene) &&
    (town.resident === null || validSnapshot(town.resident)) &&
    (town.residence === undefined || validIdentity(town.residence)) &&
    Array.isArray(town.occupants) &&
    town.occupants.every((occupant) =>
      validIdentity(occupant) &&
      isTownState({ scene: town.scene, point: occupant.point, activity: 'idle' }) &&
      validMotion(town.scene, occupant.point, occupant.motion),
    );
}

const text = {
  zh: {
    title: '陪伴小镇',
    map: '地图',
    mapTitle: '小镇地图',
    closeMap: '返回场景',
    follow: '回到角色',
    returnHome: '回到家',
    residentHere: (place) => `${place}，角色当前在这里`,
    statusTitle: '小镇角色状态',
    visitorName: '角色',
    activityLabel: '正在做',
    locationLabel: '所在位置',
    destinationLabel: '前往',
    collapseStatus: '收起角色状态',
    expandStatus: '展开角色状态',
    phases: {
      active: '活动中',
      moving: '在路上',
      resting: '休息中',
      staying: '停留中',
      paused: '已暂停',
      loading: '同步中',
      'not-resident': '未入住',
      unavailable: '状态不可用',
    },
    loading: '正在打开小镇',
    reset: '重置视角',
    retry: '重试',
    pause: '暂停',
    resume: '继续',
    walking: '正在走路',
    walkingAtHome: '正在家里走动',
    crossing: '正在过街',
    resting: '在家歇一会儿',
    visiting: '正在做客',
    streetPause: '在街边待一会儿',
    homeOf: (owner) => `${owner}的家`,
    ownHome: '自己的家',
    staying: '在这里待一会儿',
    selectCharacter: '选一个角色，就能看到对方在小镇的生活。',
    notResident: '当前角色尚未入住。可以在陪伴小镇的插件详情页选择入住角色。',
    identityUnavailable: '此版本的 LimeA 无法连接角色的小镇生活。',
    restoreFailed: '暂时无法读取角色的小镇状态，可以重试。',
    failed: (place) => `${place}暂时无法打开，可以重试。`,
    graphics: '三维画面无法启动。请在支持硬件加速的窗口中重试。',
  },
  en: {
    title: 'Companion Town',
    map: 'Map',
    mapTitle: 'Town map',
    closeMap: 'Back to scene',
    follow: 'Follow character',
    returnHome: 'Back to home',
    residentHere: (place) => `${place}, current character location`,
    statusTitle: 'Town character status',
    visitorName: 'Character',
    activityLabel: 'Activity',
    locationLabel: 'Location',
    destinationLabel: 'Heading to',
    collapseStatus: 'Collapse character status',
    expandStatus: 'Expand character status',
    phases: {
      active: 'Active',
      moving: 'On the way',
      resting: 'Resting',
      staying: 'Staying',
      paused: 'Paused',
      loading: 'Syncing',
      'not-resident': 'Not a resident',
      unavailable: 'Status unavailable',
    },
    loading: 'Opening town',
    reset: 'Reset view',
    retry: 'Try again',
    pause: 'Pause',
    resume: 'Resume',
    walking: 'Walking',
    walkingAtHome: 'Walking around at home',
    crossing: 'Crossing the street',
    resting: 'Resting at home',
    visiting: 'Visiting a resident',
    streetPause: 'Taking a moment by the street',
    homeOf: (owner) => `${owner}’s home`,
    ownHome: 'Own home',
    staying: 'Staying here for a while',
    selectCharacter: 'Choose a character to see how they spend time in town.',
    notResident: 'This character has not moved in. Choose residents on the Companion Town plugin page.',
    identityUnavailable: 'This version of LimeA cannot connect characters to town.',
    restoreFailed: 'Could not read this character’s town activity. Try again.',
    failed: (place) => `Could not open ${place}. Try again.`,
    graphics: 'The 3D view could not start. Try again in a window with graphics acceleration.',
  },
};

export function mount(container, context) {
  const language = context.language.startsWith('zh') ? 'zh' : 'en';
  const words = text[language];
  const name = (id, residence) => id === 'home' && residence?.name
    ? words.homeOf(residence.name)
    : locations[id].name[language];

  const styles = element('link');
  styles.rel = 'stylesheet';
  styles.href = new URL('town.css', context.resourceBase).href;
  const root = element('section', 'town');
  const header = element('header', 'town-header');
  const locationTitle = element('h2', 'town-location', words.title);
  const reset = element('button', 'town-reset', words.reset);
  reset.type = 'button';
  reset.disabled = true;
  const mapToggle = element('button', 'town-map-toggle', words.map);
  mapToggle.type = 'button';
  mapToggle.setAttribute('aria-expanded', 'false');
  mapToggle.setAttribute('aria-controls', 'companion-town-map');
  const actions = element('div', 'town-header-actions');
  actions.append(mapToggle, reset);
  header.append(locationTitle, actions);

  const map = createTownMap(
    context.resourceBase,
    language,
    words.mapTitle,
    words.residentHere,
    (scene) => {
      browseScene = scene;
      setMapOpen(false);
    },
  );

  const viewport = element('div', 'town-viewport');
  viewport.dataset.testid = 'town-viewport';
  viewport.hidden = true;

  const card = makeTownStatusCard(words);
  const { footer, retry, toggle, follow } = card;
  root.append(viewport, header, map.element, footer);
  root.dataset.travelling = 'false';
  root.dataset.activity = 'idle';
  root.dataset.paused = 'false';
  container.replaceChildren(styles, root);
  const footerSize = new ResizeObserver(() => {
    if (footer.offsetHeight) {
      root.style.setProperty('--town-card-reserve', `${footer.offsetHeight + 24}px`);
    }
  });
  footerSize.observe(footer);

  let viewer;
  let shownScene;
  let observation;
  let visible = false;
  let identityAvailable = false;
  let character = { characterId: null };
  let latest;
  let mapOpen = false;
  let browseScene;

  function showLoading() {
    card.setPhase('loading');
    card.setDetails(null);
    card.setNotice(words.loading);
  }

  function updateControls(pending = false) {
    reset.hidden = mapOpen;
    reset.disabled = viewport.hidden || !shownScene;
    follow.hidden = mapOpen || !browseScene;
    follow.textContent = latest ? words.follow : words.returnHome;
    toggle.hidden = !latest;
    toggle.disabled = !latest || pending;
    toggle.textContent = latest?.paused ? words.resume : words.pause;
    card.updateActions();
  }

  function label(state) {
    if (state.activity === 'crossing') return words.crossing;
    if (Object.hasOwn(activityCatalog, state.activity)) {
      return activityCatalog[state.activity].name[language];
    }
    if (state.activity === 'walking') {
      if (state.scene === 'home' && state.destination === 'home' &&
          !state.residence && !state.destinationResidence) return words.walkingAtHome;
      return words.walking;
    }
    if (state.residence) return words.visiting;
    if (state.scene === 'street_corner' &&
        (state.point === 'cafe_promenade_west' || state.point === 'east_sidewalk_junction')) {
      return words.streetPause;
    }
    if (state.scene === 'home' && state.point === locations.home.visit) return words.resting;
    return words.staying;
  }

  function updateStatus(resident, owner, readFailed) {
    retry.hidden = !readFailed;
    if (!resident) {
      card.setPhase(readFailed || !identityAvailable ? 'unavailable' : 'not-resident');
      card.setDetails(null);
      card.setNotice(
        readFailed
          ? words.restoreFailed
          : owner ? words.notResident : identityAvailable ? words.selectCharacter : words.identityUnavailable,
      );
      return;
    }

    const { activity, scene, destination, paused, residence, destinationResidence } = resident;
    const place = name(scene, residence);
    const area = townArea(resident, language);
    let next;
    if (destinationResidence) {
      if (destinationResidence.characterId !== residence?.characterId) {
        next = name('home', destinationResidence);
      }
    } else if (destination === 'home' && residence) {
      next = words.ownHome;
    } else if (destination && destination !== scene) {
      next = name(destination);
    }
    const phase = residence && activity === 'idle' ? 'active' : (activityPhase[activity] ?? 'active');
    card.setPhase(paused ? 'paused' : phase);
    card.setDetails({
      action: label(resident),
      position: area ? `${place} · ${area}` : place,
      destination: next,
    });
    card.setNotice('');
  }

  function stopObserving() {
    if (!observation) return;
    clearTimeout(observation.timer);
    observation.controller.abort();
    observation = undefined;
  }

  async function refresh(watch, paused) {
    const { owner, browse, signal } = watch;
    let town;
    let readFailed = false;
    try {
      if (owner && paused !== undefined) {
        await context.command('set-town-paused', { characterId: owner, paused });
        signal.throwIfAborted();
      }
      town = await context.command('read-town-window', {
        characterId: owner,
        ...(browse ? { scene: browse } : {}),
      });
      signal.throwIfAborted();
      if (!validWindow(town)) throw new Error('Invalid town snapshot');
    } catch (error) {
      if (signal.aborted) return;
      console.warn('Companion Town:', error);
      town = undefined;
      readFailed = true;
    }

    const resident = town?.resident ?? null;
    latest = resident ?? undefined;
    const scene = town?.scene ?? browse ?? shownScene ?? 'home';
    const occupants = town?.occupants ?? [];
    const motion = resident?.paused ? undefined : resident?.motion;
    root.dataset.resident = String(Boolean(resident));
    root.dataset.activity = resident?.activity ?? 'idle';
    root.dataset.paused = String(Boolean(resident?.paused));
    root.dataset.travelling = String(Boolean(motion && motion.endsAt > Date.now()));
    map.update(scene, resident?.scene);
    const title = name(scene, town?.residence);
    locationTitle.textContent = mapOpen ? words.mapTitle : title;
    updateStatus(resident, owner, readFailed);

    if (!mapOpen) {
      let failure = words.graphics;
      try {
        if (!viewer) {
          viewer = makeViewer(viewport, { header, footer }, context);
          viewer.setSelectedCharacter(character);
        }
        failure = words.failed(title);
        if (shownScene !== scene) {
          const model = await viewer.load(scene, signal);
          viewer.show(model, signal);
          shownScene = scene;
        }
        signal.throwIfAborted();
        viewer.setOccupants(occupants);
        root.dataset.scene = scene;
        root.dataset.point =
          occupants.find(({ characterId }) => characterId === owner)?.point ?? locations[scene].visit;
        if (viewport.hidden) {
          viewport.hidden = false;
          viewer.setVisible(true);
        }
      } catch (error) {
        if (signal.aborted) return;
        console.warn('Companion Town:', error);
        stopDrawing();
        retry.hidden = false;
        card.setNotice(failure);
        updateControls();
        return;
      }
    }

    updateControls();

    if (!readFailed) {
      const delay = mapOpen || (!resident && scene === 'home') ? 1000 : refreshInterval;
      watch.timer = setTimeout(() => void refresh(watch), delay);
    }
  }

  function observe(paused) {
    stopObserving();
    if (!visible || context.signal.aborted) return;
    retry.hidden = true;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, context.signal]);
    observation = { owner: character.characterId, browse: browseScene, controller, signal, timer: undefined };
    updateControls(true);
    void refresh(observation, paused);
  }

  function stopDrawing() {
    viewport.hidden = true;
    viewer?.setVisible(false);
  }

  function setMapOpen(value) {
    stopDrawing();
    mapOpen = value;
    map.element.hidden = !value;
    mapToggle.textContent = value ? words.closeMap : words.map;
    mapToggle.setAttribute('aria-expanded', String(value));
    const scene = browseScene ?? latest?.scene ?? shownScene ?? 'home';
    locationTitle.textContent = value ? words.mapTitle : name(scene);
    if (value) {
      map.update(scene, latest?.scene);
      map.focus(scene);
    } else {
      mapToggle.focus({ preventScroll: true });
    }
    observe();
  }

  const unsubscribeCharacter = context.onCharacterChange?.(
    ({ characterId: selected, name: displayName, avatar }) => {
      const canIdentify = selected !== undefined;
      const next = typeof selected === 'string' && selected.trim() ? selected : null;
      const changedCharacter = next !== character.characterId || canIdentify !== identityAvailable;
      character = {
        characterId: next,
        name: next ? (displayName?.trim() || words.visitorName) : undefined,
        avatar: next ? avatar : undefined,
      };
      card.setCharacter(character.name, character.avatar);
      viewer?.setSelectedCharacter(character);
      if (!changedCharacter) return;
      stopObserving();
      stopDrawing();
      identityAvailable = canIdentify;
      browseScene = undefined;
      shownScene = undefined;
      latest = undefined;
      map.update('home', undefined);
      viewer?.clear();
      delete root.dataset.scene;
      delete root.dataset.point;
      root.dataset.activity = 'idle';
      root.dataset.resident = 'false';
      root.dataset.paused = 'false';
      root.dataset.travelling = 'false';
      showLoading();
      observe();
    },
  );

  const unsubscribeVisible = context.onVisibilityChange((next) => {
    if (next === visible) return;
    visible = next;
    if (visible) {
      showLoading();
      observe();
    } else {
      stopObserving();
      stopDrawing();
    }
  });

  reset.addEventListener('click', () => viewer?.resetView());
  mapToggle.addEventListener('click', () => setMapOpen(!mapOpen));
  follow.addEventListener('click', () => {
    browseScene = undefined;
    setMapOpen(false);
  });
  root.addEventListener('keydown', (event) => {
    if (mapOpen && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setMapOpen(false);
    }
  });
  retry.addEventListener('click', () => observe());
  toggle.addEventListener('click', () => {
    if (latest) observe(!latest.paused);
  });

  return () => {
    visible = false;
    stopObserving();
    unsubscribeVisible?.();
    unsubscribeCharacter?.();
    footerSize.disconnect();
    viewer?.dispose();
    container.replaceChildren();
  };
}
