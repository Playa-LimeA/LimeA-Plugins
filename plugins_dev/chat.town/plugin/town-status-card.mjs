const areas = {
  foyer_walk: ['玄关', 'Entryway'],
  living_entry: ['客厅', 'Living room'],
  home_idle: ['客厅', 'Living room'],
  home_sofa: ['客厅', 'Living room'],
  home_sofa_approach: ['客厅', 'Living room'],
  home_breakfast: ['餐桌', 'Dining table'],
  home_breakfast_approach: ['餐区', 'Dining area'],
  home_hall: ['走廊', 'Hallway'],
  home_bed: ['卧室', 'Bedroom'],
  home_bed_approach: ['卧室', 'Bedroom'],
  home_balcony: ['阳台', 'Balcony'],
  home_computer: ['电竞房', 'Gaming room'],
  home_computer_approach: ['电竞房', 'Gaming room'],
  order_at_counter: ['吧台', 'Counter'],
  park_lookout: ['木平台', 'Pond lookout'],
  cafe_promenade_west: ['人行道', 'Sidewalk'],
  east_sidewalk_junction: ['人行道', 'Sidewalk'],
  browse_bread: ['展示柜', 'Display counter'],
  shop_sofa: ['沙发展区', 'Sofa display'],
  browse_produce: ['生鲜区', 'Produce section'],
};

export function townArea(state, language) {
  const index = language === 'zh' ? 0 : 1;
  if (
    state.scene === 'street_corner' &&
    (state.activity === 'crossing' || state.point.includes('crosswalk_road_'))
  ) return ['斑马线', 'Crosswalk'][index];
  if (state.scene === 'home' && state.point === 'from_street') return areas.foyer_walk[index];
  return areas[state.point]?.[index];
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

function button(className, text) {
  const node = element('button', className, text);
  node.type = 'button';
  return node;
}

export function makeTownStatusCard(words) {
  const footer = element('footer', 'town-footer');
  footer.setAttribute('aria-label', words.statusTitle);

  const header = element('div', 'town-card-header');
  header.hidden = true;
  const portrait = element('span', 'town-card-portrait');
  portrait.setAttribute('aria-hidden', 'true');
  const identity = element('div', 'town-card-identity');
  const name = element('h3', 'town-card-name');
  const phase = element('span', 'town-card-phase');
  identity.append(name, phase);
  const collapse = button('town-card-collapse');
  collapse.setAttribute('aria-controls', 'companion-town-status-details');
  collapse.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  header.append(portrait, identity, collapse);

  const body = element('div', 'town-card-body');
  body.id = 'companion-town-status-details';
  const fields = element('dl', 'town-card-fields');
  fields.hidden = true;
  const activity = element('dd');
  activity.setAttribute('role', 'status');
  activity.dataset.townStatus = '';
  const location = element('dd');
  const nextLabel = element('dt', null, words.destinationLabel);
  const next = element('dd');
  fields.append(
    element('dt', null, words.activityLabel),
    activity,
    element('dt', null, words.locationLabel),
    location,
    nextLabel,
    next,
  );

  const notice = element('p', 'town-card-notice', words.loading);
  notice.setAttribute('role', 'status');
  const actions = element('div', 'town-card-actions');
  const retry = button('town-retry', words.retry);
  retry.hidden = true;
  const follow = button('town-follow', words.follow);
  follow.hidden = true;
  const toggle = button('town-toggle', words.pause);
  toggle.dataset.townToggle = '';
  toggle.hidden = true;
  actions.hidden = true;
  actions.append(retry, follow, toggle);
  body.append(fields, notice, actions);
  footer.append(header, body);

  let collapsed = false;
  let previousName;
  let previousAvatar;
  function updateDisclosure() {
    body.hidden = collapsed && !header.hidden;
    collapse.setAttribute('aria-expanded', String(!body.hidden));
    collapse.setAttribute('aria-label', body.hidden ? words.expandStatus : words.collapseStatus);
  }
  collapse.addEventListener('click', () => {
    collapsed = !collapsed;
    updateDisclosure();
  });
  updateDisclosure();

  return {
    footer,
    retry,
    follow,
    toggle,
    setCharacter(displayName, avatar) {
      if (displayName === previousName && avatar === previousAvatar) return;
      previousName = displayName;
      previousAvatar = avatar;
      header.hidden = !displayName;
      setText(name, displayName ?? '');
      name.title = displayName ?? '';
      portrait.textContent = displayName ? Array.from(displayName)[0] : '';
      if (displayName && avatar) {
        const image = element('img');
        image.alt = '';
        image.draggable = false;
        image.hidden = true;
        image.addEventListener('load', () => { image.hidden = false; }, { once: true });
        image.addEventListener('error', () => image.remove(), { once: true });
        portrait.append(image);
        image.src = avatar;
      }
      updateDisclosure();
    },
    setPhase(key) {
      if (phase.dataset.phase !== key) phase.dataset.phase = key;
      setText(phase, words.phases[key]);
    },
    setDetails(details) {
      fields.hidden = !details;
      setText(activity, details?.action ?? '');
      setText(location, details?.position ?? '');
      nextLabel.hidden = next.hidden = !details?.destination;
      setText(next, details?.destination ?? '');
    },
    setNotice(message) {
      notice.hidden = !message;
      setText(notice, message ?? '');
    },
    updateActions() {
      actions.hidden = retry.hidden && follow.hidden && toggle.hidden;
    },
  };
}
