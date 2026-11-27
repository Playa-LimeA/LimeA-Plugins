import { templates } from './floors.mjs';

function svg(className, viewBox, paths) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('class', className);
  node.setAttribute('viewBox', viewBox);
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('preserveAspectRatio', 'none');
  for (const [pathClass, data] of paths) {
    const path = document.createElementNS(node.namespaceURI, 'path');
    path.setAttribute('class', pathClass);
    path.setAttribute('d', data);
    node.append(path);
  }
  return node;
}

function button(className) {
  const node = document.createElement('button');
  node.className = className;
  node.type = 'button';
  return node;
}

function floorLabel(floor, translate) {
  const code = document.createElement('span');
  code.className = 'floor-label-code';
  code.textContent = floor.code;
  const name = document.createElement('span');
  name.className = 'floor-label-name';
  name.textContent = translate(templates[floor.kind].name);
  return [code, name];
}

export function createFloorPicker(container, translate, onSelect) {
  const trigger = button('floor-trigger');
  const popup = document.createElement('div');
  popup.className = 'floor-popover';
  popup.popover = 'auto';
  trigger.popoverTargetElement = popup;
  trigger.setAttribute('aria-expanded', 'false');
  const group = document.createElement('div');
  group.className = 'floor-building';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', translate(['选择办公楼层', 'Choose an office floor']));
  const roof = svg('building-roof', '0 0 204 15', [
    ['building-roof-face', 'M1 14 23 5H203L181 14Z'],
  ]);
  const marker = svg('floor-chevron', '0 0 12 12', [['', 'm3 5 3 3 3-3']]);
  popup.append(group);
  container.append(trigger, popup);
  let rows = new Map();
  let selectedId;
  const isOpen = () => popup.matches(':popover-open');

  function close(restoreFocus = false) {
    if (!isOpen()) return;
    popup.hidePopover();
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }

  function makeRow(floor) {
    const row = button('floor-tile');
    row.dataset.floorId = floor.id;
    const shell = svg('building-shell', '0 0 204 47', [
      ['building-face', 'M1 9h180v38H1Z'],
      ['building-side', 'M181 9 203 0v38l-22 9Z'],
      ['building-window', 'M187 21l10-4v9l-10 4Z'],
    ]);
    const copy = document.createElement('span');
    copy.className = 'floor-tile-copy';
    const check = svg('floor-check', '0 0 14 14', [['', 'm3 7 2.5 2.5L11 4']]);
    copy.append(...floorLabel(floor, translate), check);
    row.append(shell, copy);
    row.onclick = () => {
      close(true);
      onSelect(floor.id);
    };
    return row;
  }

  function update(floors, selected) {
    const focusedId = container.getRootNode().activeElement?.dataset.floorId;
    if (rows.size !== floors.length) {
      rows = new Map(floors.slice().reverse().map((floor) => [floor.id, makeRow(floor)]));
      group.replaceChildren(roof, ...rows.values());
      if (isOpen() && focusedId) (rows.get(focusedId) ?? rows.get(selected.id))?.focus();
    }
    const label = translate(templates[selected.kind].name);
    const accessibleLabel = translate([
      `选择楼层，当前楼层 ${selected.code} ${label}`,
      `Choose a floor, current floor ${selected.code} ${label}`,
    ]);
    if (trigger.getAttribute('aria-label') !== accessibleLabel) {
      trigger.setAttribute('aria-label', accessibleLabel);
      trigger.replaceChildren(...floorLabel(selected, translate), marker);
    }
    selectedId = selected.id;
    for (const [id, row] of rows) {
      const pressed = String(id === selectedId);
      if (row.getAttribute('aria-pressed') !== pressed) row.setAttribute('aria-pressed', pressed);
    }
  }

  popup.addEventListener('beforetoggle', (event) => {
    trigger.setAttribute('aria-expanded', String(event.newState === 'open'));
  });
  popup.addEventListener('toggle', () => {
    if (isOpen()) rows.get(selectedId)?.focus();
  });

  return { update, close, isOpen, focus: () => trigger.focus({ preventScroll: true }) };
}
