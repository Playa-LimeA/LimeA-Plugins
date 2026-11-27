import { createOfficeActivity } from './activity.mjs';

const states = {
  'waiting-approval': ['待审批', 'Awaiting approval'],
  'waiting-user': ['等你回答', 'Waiting for you'],
  'waiting-role': ['等同事回复', 'Waiting for a colleague'],
  working: ['工作中', 'Working'],
  replying: ['回复中', 'Replying'],
  queued: ['排队中', 'Queued'],
  idle: ['待命', 'Available'],
  unknown: ['状态未知', 'Unknown'],
};

const workDescriptions = {
  'waiting-approval': ['等待任务审批', 'Waiting for task approval'],
  'waiting-user': ['等你回答问题', 'Waiting for your answer'],
  'waiting-role': ['等待同事回复', 'Waiting for a colleague'],
  working: ['正在执行任务', 'Working on a task'],
  replying: ['正在回复消息', 'Replying to a message'],
  queued: ['等待开始处理', 'Waiting to get started'],
  idle: ['在工位待命', 'Available at their desk'],
  unknown: ['暂时无法确认', 'Activity unavailable'],
};

function lookupPictureProjection({ camera, seats }) {
  function normalize(vector) {
    const length = Math.hypot(...vector);
    return vector.map((value) => value / length);
  }
  function cross([ax, ay, az], [bx, by, bz]) {
    return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
  }
  const forward = normalize(camera.target.map((value, index) => value - camera.position[index]));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const anchors = new Map(seats.map(({ id, avatar }) => [id, avatar]));
  const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
  return (seat, position) => {
    const anchor = anchors.get(seat.id);
    if (!anchor || !position) return seat.avatarCenter;
    const offset = position.map((value, index) => value - anchor[index]);
    return [
      seat.avatarCenter[0] + dot(offset, right) / camera.width,
      seat.avatarCenter[1] - (dot(offset, up) * camera.aspect) / camera.width,
    ];
  };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text) {
  const node = element('button', className, text);
  node.type = 'button';
  return node;
}

function face(container, source, name) {
  const initial = Array.from(name)[0] ?? '·';
  if (container.avatarSource === source && container.avatarInitial === initial) return;
  container.avatarSource = source;
  container.avatarInitial = initial;
  container.textContent = initial;
  if (!source) return;
  const img = element('img');
  img.alt = '';
  img.draggable = false;
  img.addEventListener(
    'error',
    () => {
      if (container.contains(img)) container.textContent = initial;
    },
    { once: true },
  );
  img.src = source;
  container.replaceChildren(img);
}

function place(node, [x, y]) {
  node.style.left = x * 100 + '%';
  node.style.top = y * 100 + '%';
}

function signText(svg, corners, layout) {
  const points = corners.map(([x, y]) => [x * layout.width, y * layout.height]);
  const [start, right, , bottom] = points;
  const width = Math.hypot(right[0] - start[0], right[1] - start[1]);
  const height = Math.hypot(bottom[0] - start[0], bottom[1] - start[1]);
  const label = document.createElementNS(svg.namespaceURI, 'text');
  label.setAttribute(
    'transform',
    'matrix(' +
      [
        (right[0] - start[0]) / width,
        (right[1] - start[1]) / width,
        (bottom[0] - start[0]) / height,
        (bottom[1] - start[1]) / height,
        ...start,
      ].join(' ') +
      ')',
  );
  label.setAttribute('x', width / 2);
  label.setAttribute('text-anchor', 'middle');
  label.setAttribute('y', height * 0.86);
  svg.append(label);
  return (text) => {
    if (label.textContent === text) return;
    label.textContent = text;
    label.setAttribute('font-size', height);
    const textWidth = label.getComputedTextLength();
    if (textWidth > width) label.setAttribute('font-size', (height * width) / textWidth);
  };
}

export async function mount(container, context) {
  const english = context.language.toLowerCase().startsWith('en');
  const t = (zh, en) => (english ? en : zh);
  const resource = (name) => new URL(name, context.resourceBase).href;
  const style = element('link');
  style.rel = 'stylesheet';
  style.href = resource('office.css');
  const picture = element('img', 'floor-image');
  picture.alt = t('通用办公层斜俯视图', 'Oblique view of the standard office floor');
  picture.draggable = false;
  picture.src = resource('assets/standard-floor.webp');
  const response = await fetch(resource('assets/standard-seats.json'), { signal: context.signal });
  if (!response.ok) throw new Error('Office floor coordinates unavailable');
  const [layout] = await Promise.all([response.json(), picture.decode()]);
  context.signal.throwIfAborted();

  const root = element('section', 'office');
  const bar = element('div', 'floor-bar');
  const floorName = element('div', 'floor-name');
  const floorCode = element('span', 'floor-code');
  const name = element('strong', null, t('通用办公层', 'Office floor'));
  const floorPicker = element('select');
  floorPicker.setAttribute('aria-label', t('选择办公楼层', 'Select office floor'));
  floorName.append(floorCode, name, floorPicker);
  const tools = element('div', 'floor-tools');
  const zoomOut = button(null, '−');
  const zoomIn = button(null, '+');
  const resetView = button('reset-view', t('复位', 'Reset'));
  resetView.title = t('回到默认视角', 'Reset view');
  resetView.setAttribute('aria-label', resetView.title);
  resetView.hidden = true;
  zoomOut.setAttribute('aria-label', t('缩小楼层', 'Zoom out'));
  zoomIn.setAttribute('aria-label', t('放大楼层', 'Zoom in'));
  const zoomValue = element('span', 'zoom-value', '100%');
  tools.append(zoomOut, zoomValue, zoomIn, resetView);
  bar.append(floorName, tools);
  const frame = element('div', 'scene-frame');
  const sceneShell = element('div', 'scene-shell');
  const stage = element('div', 'scene-stage');
  const scene = element('div', 'scene');
  scene.style.setProperty('--scene-ratio', layout.width / layout.height);
  const signage = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  signage.setAttribute('class', 'signage');
  signage.setAttribute('viewBox', '0 0 ' + layout.width + ' ' + layout.height);
  signage.setAttribute('aria-hidden', 'true');
  const markers = element('div', 'markers');
  markers.addEventListener('pointerdown', (event) => event.stopPropagation());
  scene.append(picture, signage, markers);
  stage.append(scene);
  frame.append(stage);
  const board = element('section', 'member-board');
  board.id = 'office-member-board';
  board.tabIndex = -1;
  board.setAttribute('aria-label', t('成员状态看板', 'Member status panel'));
  board.hidden = true;
  const boardHeader = element('header', 'member-board-header');
  const boardPortrait = element('span', 'member-board-portrait');
  boardPortrait.setAttribute('aria-hidden', 'true');
  const boardTitle = element('div', 'member-board-title');
  const boardName = element('h3', 'member-board-name');
  const boardStatus = element('span', 'member-board-status activity');
  boardTitle.append(boardName, boardStatus);
  const closeBoardButton = button('member-board-close', '×');
  closeBoardButton.setAttribute('aria-label', t('关闭状态看板', 'Close member status'));
  boardHeader.append(boardPortrait, boardTitle, closeBoardButton);
  const boardFields = element('dl', 'member-board-fields');
  const boardAction = element('dd', 'member-board-action');
  const boardArea = element('dd', 'member-board-area');
  boardFields.append(
    element('dt', null, t('正在做', 'Activity')),
    boardAction,
    element('dt', null, t('所在区域', 'Area')),
    boardArea,
  );
  board.append(boardHeader, boardFields);
  sceneShell.append(frame, board);
  const membersArea = element('section', 'members');
  const rosterTitle = element('div', 'roster-title');
  const count = element('span', 'count');
  rosterTitle.append(element('h3', null, t('本层成员', 'On this floor')), count);
  const notice = element('p', 'notice');
  notice.setAttribute('role', 'status');
  const roster = element('div', 'roster');
  membersArea.append(rosterTitle, notice, roster);
  root.append(bar, sceneShell, membersArea);
  container.append(style, root);
  const setFloorSign = signText(signage, layout.elevatorSign.floorNumberQuad, layout);
  const setCompanySign = signText(signage, layout.elevatorSign.companyNameQuad, layout);
  let floor = 0;
  let floorCount = 0;
  let zoom = 1;
  let snapshot = null;
  let visible = true;
  let selectedId = null;
  let boardTrigger = null;
  let orbit;
  let officeActivity;
  let projectPicture = (seat) => seat.avatarCenter;
  const people = new Map();
  const translate = (pair) => pair[english ? 1 : 0];

  function status(member) {
    const value = snapshot.activityState === 'ready' ? member.activity : 'unknown';
    return { value, text: (states[value] ?? states.unknown)[english ? 1 : 0] };
  }

  function showBoard(id, trigger) {
    const view = people.get(id);
    if (!view) return;
    closeBoard(false);
    selectedId = id;
    boardTrigger = trigger;
    for (const target of [view.marker, view.row]) target.setAttribute('aria-expanded', 'true');
    updateBoard();
    board.hidden = false;
    board.focus({ preventScroll: true });
  }

  function closeBoard(restoreFocus) {
    const view = people.get(selectedId);
    if (view) {
      for (const target of [view.marker, view.row]) target.setAttribute('aria-expanded', 'false');
      if (restoreFocus) {
        const trigger = boardTrigger?.isConnected && !boardTrigger.hidden ? boardTrigger : view.row;
        trigger.focus({ preventScroll: true });
      }
    }
    selectedId = null;
    boardTrigger = null;
    board.hidden = true;
  }

  function describeActivity(view, moment) {
    const state = snapshot.rosterState === 'failed' ? 'unknown' : view.activity.value;
    const action = (state === 'idle' && moment?.action) || workDescriptions[state];
    return { state, action: translate(action) };
  }

  function updateBoard() {
    const view = people.get(selectedId);
    if (!view) return;
    const { member, seat } = view;
    const moment = officeActivity?.get(selectedId);
    const { state, action } = describeActivity(view, moment);
    const area = moment?.area ?? [seat.id.startsWith('A') ? 'A 区' : 'B 区', 'Zone ' + seat.id[0]];
    face(boardPortrait, member.avatar, member.name);
    for (const [node, value] of [
      [boardName, member.name],
      [boardStatus, translate(states[state])],
      [boardAction, action],
      [boardArea, translate(area)],
    ]) {
      if (node.textContent !== value) node.textContent = value;
    }
    if (boardStatus.dataset.state !== state) boardStatus.dataset.state = state;
  }

  function makePerson(id) {
    const marker = button('seat activity');
    const portrait = element('span', 'seat-face');
    marker.append(portrait, element('span', 'dot'));
    const label = element('span', 'seat-label activity');
    const labelText = element('span', 'seat-label-text');
    label.setAttribute('aria-hidden', 'true');
    label.append(element('span', 'dot'), labelText);
    markers.append(marker, label);
    const row = button('person activity');
    const rowFace = element('span', 'person-face');
    const info = element('span', 'person-info');
    const displayName = element('span', 'person-name');
    const statusLine = element('span', 'person-status');
    const activityText = element('span');
    statusLine.append(element('span', 'dot'), activityText);
    info.append(displayName, statusLine);
    row.append(rowFace, info);
    for (const target of [row, marker]) {
      target.setAttribute('aria-controls', board.id);
      target.setAttribute('aria-expanded', 'false');
      target.onclick = () => showBoard(id, target);
    }
    return { marker, portrait, label, labelText, row, rowFace, displayName, activityText };
  }

  function updateLabels() {
    const width = scene.clientWidth;
    markers.style.setProperty('--marker-size', Math.min(32, Math.max(14, width * 0.044)) + 'px');
    // Check actual translated labels against neighbouring labels and avatars.
    const boxes = [...people.values()]
      .filter(({ marker }) => !marker.hidden)
      .map(({ marker }) => marker.getBoundingClientRect());
    for (const { label, marker } of people.values()) {
      label.hidden = marker.hidden || width < 550;
      if (label.hidden) continue;
      label.style.marginTop = '0';
      const overlap = label.getBoundingClientRect().bottom - marker.getBoundingClientRect().top + 3;
      if (overlap > 0) label.style.marginTop = -overlap + 'px';
      const rect = label.getBoundingClientRect();
      if (
        boxes.some(
          (box) =>
            rect.left < box.right + 1 &&
            rect.right > box.left - 1 &&
            rect.top < box.bottom + 1 &&
            rect.bottom > box.top - 1,
        )
      )
        label.hidden = true;
      else boxes.push(rect);
    }
  }

  function projectMarkers(project) {
    for (const [id, view] of people) {
      const { marker, label, labelText, seat } = view;
      const moment = officeActivity?.get(id);
      const { state, action } = describeActivity(view, moment);
      if (labelText.textContent !== action) {
        labelText.textContent = action;
        marker.setAttribute('aria-description', action);
      }
      if (label.dataset.state !== state) label.dataset.state = state;
      const position = moment?.position;
      const point = project(seat, position);
      marker.hidden = point === null;
      if (!point) continue;
      place(marker, point);
      place(label, !orbit && !position ? seat.statusCenter : [point[0], point[1] - 0.035]);
    }
    updateLabels();
  }

  function updateOfficeActivity() {
    if (!visible) return;
    projectMarkers(orbit?.project ?? projectPicture);
    updateBoard();
  }

  function syncOfficeActivity() {
    if (!officeActivity) return;
    // A loading snapshot is also sent while reopening the same plugin view.
    if (!visible || snapshot?.rosterState !== 'ready') {
      officeActivity.setVisible(false);
      return;
    }
    officeActivity.setMembers(
      [...people].map(([id, { seat, activity }]) => ({
        id,
        seatId: seat.id,
        activity: activity.value,
      })),
    );
    officeActivity.setVisible(true);
  }

  function render() {
    if (!snapshot || !visible) return;
    if (snapshot.rosterState !== 'ready') {
      notice.textContent =
        snapshot.rosterState === 'failed'
          ? t('暂时无法读取工位', 'Seats are temporarily unavailable')
          : t('正在读取工位…', 'Loading seats…');
      syncOfficeActivity();
      updateOfficeActivity();
      return;
    }
    const ordinary = snapshot.members.filter(
      (m) => Number.isInteger(m.seatIndex) && m.seatIndex >= 0,
    );
    const total = ordinary.reduce(
      (n, m) => Math.max(n, 1 + Math.floor(m.seatIndex / layout.capacity)),
      1,
    );
    if (total !== floorCount) {
      floorCount = total;
      floor = Math.min(floor, total - 1);
      floorPicker.replaceChildren(
        ...Array.from({ length: total }, (_, i) => {
          const option = element('option', null, t('通用办公层', 'Office floor') + ' ' + (i + 1));
          option.value = String(i);
          return option;
        }),
      );
    }
    floorPicker.hidden = floorCount <= 1;
    name.hidden = !floorPicker.hidden;
    floorPicker.value = String(floor);
    const code = String(floor + 2).padStart(2, '0') + 'F';
    floorCode.textContent = code;
    setFloorSign(code);
    setCompanySign(snapshot.companyName);
    const members = ordinary
      .filter((m) => Math.floor(m.seatIndex / layout.capacity) === floor)
      .sort((a, b) => a.seatIndex - b.seatIndex);
    const ids = new Set(members.map((m) => m.characterId));
    if (selectedId !== null && !ids.has(selectedId)) {
      const boardFocused = board.contains(root.getRootNode().activeElement);
      closeBoard(false);
      if (boardFocused)
        (floorPicker.hidden ? (resetView.hidden ? zoomIn : resetView) : floorPicker).focus();
    }
    for (const [id, view] of people) {
      if (ids.has(id)) continue;
      view.marker.remove();
      view.row.remove();
      view.label.remove();
      people.delete(id);
    }
    members.forEach((member, index) => {
      const id = member.characterId;
      const view = people.get(id) ?? makePerson(id);
      people.set(id, view);
      const seat = layout.seats[member.seatIndex % layout.capacity];
      view.seat = seat;
      view.member = member;
      const activity = status(member);
      view.activity = activity;
      const description = member.name + ' · ' + activity.text + ' · ' + seat.id;
      for (const target of [view.marker, view.row]) {
        target.setAttribute('aria-label', description);
        target.dataset.state = activity.value;
        target.dataset.seat = seat.id;
      }
      view.activityText.textContent = activity.text;
      view.displayName.textContent = member.name;
      face(view.portrait, member.avatar, member.name);
      face(view.rowFace, member.avatar, member.name);
      if (roster.children[index] !== view.row)
        roster.insertBefore(view.row, roster.children[index] ?? null);
    });
    count.textContent = members.length + ' / ' + layout.capacity;
    notice.textContent = members.length ? '' : t('本层暂无成员', 'No members on this floor');
    syncOfficeActivity();
    updateOfficeActivity();
  }

  function changeZoom(requested, pointer) {
    const next = Math.min(2, Math.max(1, requested));
    if (next === zoom) return;
    zoom = next;
    if (orbit) orbit.zoom(next, pointer);
    else zoomPicture(pointer);
    zoomOut.disabled = zoom <= 1;
    zoomIn.disabled = zoom >= 2;
    zoomValue.textContent = Math.round(zoom * 100) + '%';
  }

  function zoomPicture(pointer) {
    const viewport = frame.getBoundingClientRect();
    const before = scene.getBoundingClientRect();
    const x = pointer?.clientX ?? viewport.left + viewport.width / 2;
    const y = pointer?.clientY ?? viewport.top + viewport.height / 2;
    const offsetX = (x - before.left) / before.width;
    const offsetY = (y - before.top) / before.height;
    scene.style.setProperty('--zoom', zoom);
    const after = scene.getBoundingClientRect();
    frame.scrollTo({
      left: frame.scrollLeft + after.left + after.width * offsetX - x,
      top: frame.scrollTop + after.top + after.height * offsetY - y,
    });
    updateLabels();
  }
  zoomOut.disabled = true;
  zoomOut.onclick = () => changeZoom(zoom - 0.5);
  zoomIn.onclick = () => changeZoom(zoom + 0.5);
  resetView.onclick = () => {
    changeZoom(1);
    orbit?.reset();
  };
  frame.addEventListener(
    'wheel',
    (event) => {
      const units = event.deltaMode;
      if (event.deltaY === 0 || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      event.preventDefault();
      const pixels = event.deltaY * (units === 1 ? 16 : units === 2 ? frame.clientHeight : 1);
      changeZoom(zoom * Math.exp(-pixels / 650), event);
    },
    { passive: false, signal: context.signal },
  );
  closeBoardButton.onclick = () => closeBoard(true);
  root.onkeydown = (event) => {
    if (event.key !== 'Escape' || board.hidden || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    closeBoard(true);
  };
  floorPicker.onchange = () => {
    floor = Number(floorPicker.value);
    render();
  };
  const observer = new ResizeObserver(() => {
    if (visible) updateOfficeActivity();
  });
  observer.observe(scene);
  const stopVisibility = context.onVisibilityChange((next) => {
    visible = next;
    orbit?.setVisible(next);
    if (!visible) officeActivity?.setVisible(false);
  });
  const stop = context.subscribe((next) => {
    snapshot = next;
    render();
  });
  function showPicture() {
    orbit?.dispose();
    orbit = undefined;
    delete frame.dataset.orbit;
    scene.removeAttribute('tabindex');
    scene.removeAttribute('aria-label');
    scene.removeAttribute('title');
    scene.removeAttribute('role');
    resetView.hidden = true;
    scene.style.setProperty('--zoom', zoom);
    render();
  }

  void (async () => {
    try {
      const metadata = await fetch(resource('assets/standard-scene.json'), {
        signal: context.signal,
      });
      if (!metadata.ok) throw new Error('Office scene coordinates are unavailable');
      const sceneLayout = await metadata.json();
      context.signal.throwIfAborted();
      projectPicture = lookupPictureProjection(sceneLayout);
      officeActivity = createOfficeActivity(sceneLayout, updateOfficeActivity, {
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      });
      syncOfficeActivity();
      updateOfficeActivity();
      const { createOfficeOrbit } = await import('./orbit.mjs');
      context.signal.throwIfAborted();
      const next = await createOfficeOrbit(scene, {
        url: resource('assets/standard-floor.glb'),
        layout: sceneLayout,
        signal: context.signal,
        visible,
        onRender: projectMarkers,
        onLost: showPicture,
      });
      if (context.signal.aborted) {
        next.dispose();
        return;
      }
      orbit = next;
      frame.dataset.orbit = 'true';
      resetView.hidden = false;
      scene.tabIndex = 0;
      scene.setAttribute('role', 'group');
      scene.title = t('按住拖动旋转，滚轮缩放', 'Drag to rotate. Scroll to zoom.');
      scene.setAttribute(
        'aria-label',
        t(
          '办公楼层。拖动或按方向键旋转，滚轮缩放。',
          'Office floor. Drag or use arrow keys to rotate. Scroll to zoom.',
        ),
      );
      orbit.zoom(zoom);
      orbit.setVisible(visible);
    } catch (error) {
      if (!context.signal.aborted) console.warn('Office 3D view unavailable', error);
    }
  })();

  return () => {
    stop();
    stopVisibility();
    officeActivity?.dispose();
    orbit?.dispose();
    observer.disconnect();
    root.remove();
    style.remove();
  };
}
