import { Vector3 } from './vendor/three-town.mjs';

export function makeVisitor(viewport, context) {
  const marker = document.createElement('span');
  marker.className = 'town-role';
  marker.setAttribute('role', 'img');
  marker.hidden = true;

  const face = document.createElement('span');
  face.className = 'town-role-face';
  marker.append(face);
  viewport.append(marker);

  const fallbackName = context.language.startsWith('zh') ? '角色' : 'Visitor';
  let displayName;
  let avatarSource;

  function setCharacter({ name, avatar }) {
    const nextName = name?.trim() || fallbackName;
    const nextAvatar = avatar || null;
    if (displayName === nextName && avatarSource === nextAvatar) return;
    displayName = nextName;
    avatarSource = nextAvatar;
    marker.setAttribute('aria-label', displayName);
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

  setCharacter({ name: context.characterName });
  const unsubscribe = context.onCharacterChange?.(setCharacter);
  const position = new Vector3();
  const projected = new Vector3();

  return {
    position,
    hide() {
      marker.hidden = true;
    },
    project(camera) {
      if (!context.onCharacterChange) setCharacter({ name: context.characterName });
      projected.copy(position);
      projected.y += 0.12;
      projected.project(camera);
      marker.hidden =
        Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1 || Math.abs(projected.z) > 1;
      if (marker.hidden) return;
      marker.style.left = ((projected.x + 1) * 50) + '%';
      marker.style.top = ((1 - projected.y) * 50) + '%';
    },
    dispose() {
      unsubscribe?.();
      marker.remove();
    },
  };
}
