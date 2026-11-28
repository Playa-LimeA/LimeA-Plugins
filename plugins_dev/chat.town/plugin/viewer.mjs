import {
  ACESFilmicToneMapping,
  Box3,
  GLTFLoader,
  OrbitControls,
  OrthographicCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from './vendor/three-town.mjs';
import { makeTownLighting } from './town-lighting.mjs';
import { makeVisitor } from './visitor.mjs';

const diagonal = new Vector3(0.84, 0.97, 1.34).normalize();
const streetDiagonal = new Vector3(-0.66, 1.03, 1.36).normalize();
const up = new Vector3(0, 1, 0);
const markerSpacing = 41;
const markerOffsets = [];
for (let x = -3; x <= 3; x++) {
  for (let y = -3; y <= 3; y++) markerOffsets.push({ x, y });
}
markerOffsets.sort((a, b) => a.x ** 2 + a.y ** 2 - b.x ** 2 - b.y ** 2 || a.y - b.y || b.x - a.x);

function disposeModel(root) {
  const resources = new Set();
  root.traverse((object) => {
    if (!object.isMesh) return;
    resources.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      resources.add(material);
      for (const value of Object.values(material)) {
        if (value?.isTexture) resources.add(value);
      }
    }
  });
  for (const resource of resources) resource.dispose();
}

function readModel(root, location) {
  root.updateMatrixWorld(true);
  const bounds = new Box3();
  const points = new Map();
  root.traverse((object) => {
    if (object.isMesh) bounds.expandByObject(object);
    const { point_id: key, scene_id: scene } = object.userData;
    if (scene === location && typeof key === 'string') {
      if (points.has(key)) throw new Error(`Duplicate point ${location}/${key}`);
      points.set(key, { ...object.userData, position: object.getWorldPosition(new Vector3()) });
    }
  });
  if (bounds.isEmpty() || points.size === 0) throw new Error(`Empty location ${location}`);
  return { root, bounds, points, view: location === 'street_corner' ? streetDiagonal : diagonal };
}

export function makeViewer(viewport, { header, footer }, context) {
  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  viewport.prepend(renderer.domElement);

  const scene = new Scene();
  const updateLighting = makeTownLighting(scene, renderer);

  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.05, 180);
  const controls = new OrbitControls(camera, viewport);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.enablePan = false;
  controls.minZoom = 0.68;
  controls.maxZoom = 3.5;
  controls.minPolarAngle = 0.25;
  controls.maxPolarAngle = 1.42;
  const visitors = new Map();
  let orderedVisitors = [];
  let selectedCharacter;
  const fallbackName = context.language.startsWith('zh') ? '住客' : 'Resident';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const loader = new GLTFLoader();
  let activeModel = null;
  let visible = false;
  let stopped = false;
  let frame = 0;
  let modelNeedsDrawing = true;
  let viewWidth = 0;
  let viewHeight = 0;
  const horizontal = new Vector3();
  const vertical = new Vector3();

  function requestDraw() {
    if (visible && !stopped && !frame) frame = requestAnimationFrame(draw);
  }

  function invalidateModel() {
    modelNeedsDrawing = true;
    requestDraw();
  }

  function updateMotion({ marker, motion }, now) {
    if (!motion) return false;
    const { from, to, startsAt, endsAt } = motion;
    const elapsed = (now - startsAt) / (endsAt - startsAt);
    const fraction = reduceMotion.matches ? 1 : Math.max(0, Math.min(1, elapsed));
    marker.position.lerpVectors(from, to, fraction);
    return fraction < 1;
  }

  function projectVisitors() {
    // Separate overlapping badges in screen space while preserving their walk points.
    const used = [];
    for (const { marker } of orderedVisitors) {
      const projected = marker.project(camera);
      if (!projected) {
        marker.hide();
        continue;
      }
      const x = ((projected.x + 1) * viewWidth) / 2;
      const y = ((1 - projected.y) * viewHeight) / 2;
      let visiblePoint = { x, y };
      for (const offset of markerOffsets) {
        const xOffset = x + offset.x * markerSpacing;
        const yOffset = y + offset.y * markerSpacing;
        if (
          (offset.x || offset.y) &&
          (xOffset < 18 || xOffset > viewWidth - 18 || yOffset < 36 || yOffset > viewHeight - 5)
        ) continue;
        if (used.every((point) => (point.x - xOffset) ** 2 + (point.y - yOffset) ** 2 >= markerSpacing ** 2)) {
          visiblePoint = { x: xOffset, y: yOffset };
          break;
        }
      }
      used.push(visiblePoint);
      marker.show(visiblePoint.x, visiblePoint.y);
    }
  }

  function clearVisitors() {
    for (const { marker } of visitors.values()) marker.dispose();
    visitors.clear();
    orderedVisitors = [];
  }

  function updateVisitorIdentity(visitor, characterId) {
    const selected = selectedCharacter?.characterId === characterId;
    visitor.marker.setCharacter({
      selected,
      name: (selected ? selectedCharacter.name : null) || visitor.name,
      avatar: selected ? selectedCharacter.avatar : visitor.avatar,
    });
  }

  function updateVisitorPosition(visitor, point, timeline) {
    const position = activeModel.points.get(point)?.position;
    if (!position) throw new Error(`Missing town point ${point}`);
    if (!timeline) {
      if (!visitor.motion && visitor.marker.position.equals(position)) return false;
      visitor.motion = null;
      visitor.marker.position.copy(position);
      return true;
    }

    const from = activeModel.points.get(timeline.from)?.position;
    const to = activeModel.points.get(timeline.to)?.position;
    if (!from || !to) throw new Error(`Missing walk ${timeline.from} → ${timeline.to}`);
    const { startsAt, endsAt } = timeline;
    const previous = visitor.motion;
    if (previous?.from === from && previous.to === to &&
        previous.startsAt === startsAt && previous.endsAt === endsAt) return false;
    visitor.motion = { from, to, startsAt, endsAt };
    return true;
  }

  function draw() {
    frame = 0;
    let moving = false;
    const now = Date.now();
    for (const visitor of orderedVisitors) moving = updateMotion(visitor, now) || moving;
    controls.update();
    if (modelNeedsDrawing) {
      renderer.render(scene, camera);
      modelNeedsDrawing = false;
    }
    if (activeModel) projectVisitors();
    if (moving) requestDraw();
  }

  function resize() {
    const { width, height } = viewport.getBoundingClientRect();
    if (width < 1 || height < 1) return;
    viewWidth = width;
    viewHeight = height;
    renderer.setSize(width, height, false);
    if (activeModel) {
      const size = activeModel.bounds.getSize(new Vector3()).multiplyScalar(0.5);
      horizontal.crossVectors(up, activeModel.view).normalize();
      vertical.crossVectors(activeModel.view, horizontal).normalize();
      const widthFit =
        Math.abs(horizontal.x) * size.x +
        Math.abs(horizontal.y) * size.y +
        Math.abs(horizontal.z) * size.z;
      const heightFit =
        Math.abs(vertical.x) * size.x +
        Math.abs(vertical.y) * size.y +
        Math.abs(vertical.z) * size.z;
      const topInset = header.offsetTop + header.offsetHeight + 8;
      const bottomInset = height - footer.offsetTop + 8;
      const usableWidth = Math.max(1, width - 24);
      const usableHeight = Math.max(1, height - topInset - bottomInset);
      const unitsPerPixel = Math.max((widthFit * 2) / usableWidth, (heightFit * 2) / usableHeight);
      const halfWidth = (width * unitsPerPixel) / 2;
      const halfHeight = (height * unitsPerPixel) / 2;
      const verticalOffset = ((topInset - bottomInset) * unitsPerPixel) / 2;
      camera.left = -halfWidth;
      camera.right = halfWidth;
      camera.top = halfHeight + verticalOffset;
      camera.bottom = -halfHeight + verticalOffset;
      camera.updateProjectionMatrix();
    }
    invalidateModel();
  }

  function resetView() {
    if (!activeModel) return;
    const center = activeModel.bounds.getCenter(new Vector3());
    camera.position.copy(center).addScaledVector(activeModel.view, 40);
    controls.target.copy(center);
    camera.zoom = 1;
    resize();
    controls.update();
  }

  controls.addEventListener('change', invalidateModel);
  reduceMotion.addEventListener('change', requestDraw);
  const sizes = new ResizeObserver(resize);
  sizes.observe(viewport);
  sizes.observe(header);
  sizes.observe(footer);

  return {
    async load(location, signal = context.signal) {
      const url = new URL(`assets/${location}.glb`, context.resourceBase);
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`Could not load ${location} (${response.status})`);
      const bytes = await response.arrayBuffer();
      signal.throwIfAborted();
      const { scene: root } = await loader.parseAsync(bytes, new URL('.', url).href);
      try {
        signal.throwIfAborted();
        return readModel(root, location);
      } catch (error) {
        disposeModel(root);
        throw error;
      }
    },
    show(model, signal) {
      if (signal.aborted) {
        disposeModel(model.root);
        signal.throwIfAborted();
      }
      if (activeModel) {
        scene.remove(activeModel.root);
        disposeModel(activeModel.root);
      }
      activeModel = model;
      clearVisitors();
      scene.add(model.root);
      resetView();
    },
    setOccupants(occupants) {
      let changed = false;
      const present = new Set();
      for (const { characterId, name, avatar, point, motion } of occupants) {
        let visitor = visitors.get(characterId);
        if (!visitor) {
          visitor = { marker: makeVisitor(viewport, fallbackName), motion: null };
          visitors.set(characterId, visitor);
          changed = true;
        }
        present.add(characterId);
        visitor.name = name;
        visitor.avatar = avatar;
        updateVisitorIdentity(visitor, characterId);
        changed = updateVisitorPosition(visitor, point, motion) || changed;
      }
      for (const [characterId, { marker }] of visitors) {
        if (!present.has(characterId)) {
          marker.dispose();
          visitors.delete(characterId);
          changed = true;
        }
      }
      if (changed) {
        const selected = selectedCharacter?.characterId;
        orderedVisitors = [...visitors.keys()].sort((a, b) =>
          a === selected ? -1 : b === selected ? 1 : a.localeCompare(b)
        ).map((id) => visitors.get(id));
        requestDraw();
      }
    },
    setSelectedCharacter(character) {
      selectedCharacter = character;
      for (const [id, visitor] of visitors) updateVisitorIdentity(visitor, id);
    },
    setTownTime(time) {
      if (updateLighting(time)) invalidateModel();
    },
    clear() {
      if (activeModel) {
        scene.remove(activeModel.root);
        disposeModel(activeModel.root);
        activeModel = null;
      }
      clearVisitors();
      invalidateModel();
    },
    setVisible(value) {
      visible = value;
      if (value) resize();
      else {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    },
    resetView,
    dispose() {
      stopped = true;
      cancelAnimationFrame(frame);
      sizes.disconnect();
      controls.removeEventListener('change', invalidateModel);
      reduceMotion.removeEventListener('change', requestDraw);
      controls.dispose();
      if (activeModel) disposeModel(activeModel.root);
      clearVisitors();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
