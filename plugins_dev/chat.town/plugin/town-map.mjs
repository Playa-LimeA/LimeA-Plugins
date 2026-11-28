import { locations } from './locations.mjs';

// Labels sit over the entrances and paths illustrated in the map's 640 × 500 viewBox.
const places = {
  cafe: [93, 157],
  shop: [235, 157],
  park: [365, 88],
  supermarket: [540, 84],
  bakery: [540, 213],
  street_corner: [306, 286],
  home: [191, 406],
};

export function createTownMap(resourceBase, language, title, residentHere, onVisit) {
  const element = document.createElement('section');
  element.id = 'companion-town-map';
  element.className = 'town-map';
  element.setAttribute('aria-label', title);
  element.hidden = true;

  const board = document.createElement('div');
  board.className = 'town-map-board';
  const art = document.createElement('img');
  art.className = 'town-map-art';
  art.src = new URL('assets/town-map.svg', resourceBase).href;
  art.alt = '';
  art.draggable = false;
  board.append(art);

  const buttons = new Map();
  for (const [scene, [x, y]] of Object.entries(places)) {
    const name = locations[scene].name[language];
    const button = document.createElement('button');
    button.className = 'town-map-place';
    button.type = 'button';
    button.textContent = name;
    button.dataset.townDestination = scene;
    button.style.setProperty('--map-x', `${(x / 640) * 100}%`);
    button.style.setProperty('--map-y', `${(y / 500) * 100}%`);
    button.addEventListener('click', () => onVisit(scene));
    buttons.set(scene, button);
    board.append(button);
  }
  element.append(board);

  let lastView;
  let lastResident;
  return {
    element,
    update(view, resident) {
      if (view === lastView && resident === lastResident) return;
      lastView = view;
      lastResident = resident;
      for (const [scene, button] of buttons) {
        button.setAttribute('aria-current', scene === view ? 'location' : 'false');
        button.toggleAttribute('data-resident', scene === resident);
        if (scene === resident) {
          button.setAttribute('aria-label', residentHere(locations[scene].name[language]));
        } else {
          button.removeAttribute('aria-label');
        }
      }
    },
    focus(scene) {
      buttons.get(scene)?.focus();
    },
  };
}
