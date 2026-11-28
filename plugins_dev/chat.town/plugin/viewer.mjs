import {
  ACESFilmicToneMapping,
  Box3,
  Color,
  DirectionalLight,
  GLTFLoader,
  HemisphereLight,
  OrbitControls,
  OrthographicCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from './vendor/three-town.mjs';
import { makeVisitor } from './visitor.mjs';

const diagonal = new Vector3(0.84, 0.97, 1.34).normalize();
const streetDiagonal = new Vector3(-0.66, 1.03, 1.36).normalize();
const up = new Vector3(0, 1, 0);

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
  renderer.toneMappingExposure = 1.1;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  viewport.prepend(renderer.domElement);

  const scene = new Scene();
  scene.background = new Color(0xe7ddd0);
  scene.add(new HemisphereLight(0xfff4e8, 0xa9a590, 2.0));
  const sunlight = new DirectionalLight(0xfff0db, 1.8);
  sunlight.position.set(-5, 9, 5);
  scene.add(sunlight);
  const fill = new DirectionalLight(0xe7f3ff, 0.58);
  fill.position.set(5, 4, -6);
  scene.add(fill);

  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.05, 180);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.enablePan = false;
  controls.minZoom = 0.68;
  controls.maxZoom = 3.5;
  controls.minPolarAngle = 0.25;
  controls.maxPolarAngle = 1.42;
  const visitor = makeVisitor(viewport, context);

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const loader = new GLTFLoader();
  let activeModel = null;
  let showVisitor = false;
  let motion = null;
  let visible = false;
  let stopped = false;
  let frame = 0;
  const horizontal = new Vector3();
  const vertical = new Vector3();

  function requestDraw() {
    if (visible && !stopped && !frame) frame = requestAnimationFrame(draw);
  }

  function updateMotion() {
    if (!motion) return false;
    const { from, to, startsAt, endsAt } = motion;
    const elapsed = (Date.now() - startsAt) / (endsAt - startsAt);
    const fraction = reduceMotion.matches ? 1 : Math.max(0, Math.min(1, elapsed));
    visitor.position.lerpVectors(from, to, fraction);
    return fraction < 1;
  }

  function draw() {
    frame = 0;
    const moving = updateMotion();
    controls.update();
    renderer.render(scene, camera);
    if (activeModel && showVisitor) visitor.project(camera);
    if (moving) requestDraw();
  }

  function resize() {
    const { width, height } = viewport.getBoundingClientRect();
    if (width < 1 || height < 1) return;
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
    requestDraw();
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

  controls.addEventListener('change', requestDraw);
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
    show(model, point, signal, options) {
      if (signal.aborted) {
        disposeModel(model.root);
        signal.throwIfAborted();
      }
      const marker = model.points.get(point);
      if (!marker) {
        disposeModel(model.root);
        throw new Error(`Missing arrival point ${point}`);
      }
      if (activeModel) {
        scene.remove(activeModel.root);
        disposeModel(activeModel.root);
      }
      activeModel = model;
      showVisitor = options.showVisitor;
      motion = null;
      scene.add(model.root);
      visitor.position.copy(marker.position);
      visitor.hide();
      resetView();
    },
    place(point, timeline) {
      const marker = activeModel.points.get(point);
      if (!marker) throw new Error(`Missing town point ${point}`);
      if (!timeline) {
        if (!motion && visitor.position.equals(marker.position)) return;
        motion = null;
        visitor.position.copy(marker.position);
      } else {
        const from = activeModel.points.get(timeline.from)?.position;
        const to = activeModel.points.get(timeline.to)?.position;
        if (!from || !to) throw new Error(`Missing walk ${timeline.from} → ${timeline.to}`);
        const { startsAt, endsAt } = timeline;
        if (
          motion?.from === from &&
          motion.to === to &&
          motion.startsAt === startsAt &&
          motion.endsAt === endsAt
        ) {
          return;
        }
        motion = { from, to, startsAt, endsAt };
        updateMotion();
      }
      requestDraw();
    },
    setVisitorVisible(value) {
      if (showVisitor === value) return;
      showVisitor = value;
      if (!value) visitor.hide();
      requestDraw();
    },
    clear() {
      motion = null;
      if (activeModel) {
        scene.remove(activeModel.root);
        disposeModel(activeModel.root);
        activeModel = null;
      }
      visitor.hide();
      requestDraw();
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
      motion = null;
      sizes.disconnect();
      controls.removeEventListener('change', requestDraw);
      controls.dispose();
      if (activeModel) disposeModel(activeModel.root);
      visitor.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
