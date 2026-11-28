import { Vector3 } from './vendor/three-town.mjs';

export function makeVisitor(viewport, fallbackName) {
  const marker = document.createElement('span');
  marker.className = 'town-role';
  marker.setAttribute('role', 'img');
  marker.hidden = true;

  const face = document.createElement('span');
  face.className = 'town-role-face';
  marker.append(face);
  viewport.append(marker);

  let displayName;
  let avatarSource;

  function setCharacter({ name, avatar, selected }) {
    marker.classList.toggle('town-role-selected', selected);
    const nextName = name?.trim() || fallbackName;
    const nextAvatar = avatar || null;
    if (displayName === nextName && avatarSource === nextAvatar) return;
    displayName = nextName;
    avatarSource = nextAvatar;
    marker.setAttribute('aria-label', displayName);
    marker.title = displayName;
    face.textContent = Array.from(displayName)[0];
    if (!avatarSource) return;

    const image = document.createElement('img');
    image.alt = '';
    image.draggable = false;
    image.hidden = true;
    image.addEventListener(
      'load',
      () => {
        image.hidden = false;
      },
      { once: true },
    );
    image.addEventListener('error', () => image.remove(), { once: true });
    face.append(image);
    image.src = avatarSource;
  }

  const position = new Vector3();
  const projected = new Vector3();

  return {
    position,
    setCharacter,
    hide() {
      marker.hidden = true;
    },
    project(camera) {
      projected.copy(position);
      projected.y += 0.12;
      projected.project(camera);
      return Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 && Math.abs(projected.z) <= 1
        ? projected
        : null;
    },
    show(x, y) {
      marker.hidden = false;
      marker.style.left = `${x}px`;
      marker.style.top = `${y}px`;
    },
    dispose() {
      marker.remove();
    },
  };
}
