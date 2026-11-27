import {
  ACESFilmicToneMapping,
  DirectionalLight,
  GLTFLoader,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  OrbitControls,
  OrthographicCamera,
  PCFShadowMap,
  PlaneGeometry,
  Raycaster,
  Scene,
  ShadowMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
  VideoTexture,
  WebGLRenderer,
} from './vendor/three-office.mjs';

function disposeModel(root) {
  const geometries = new Set();
  const materials = new Set();
  root.traverse((object) => {
    if (!object.isMesh) return;
    geometries.add(object.geometry);
    for (const material of [object.material].flat()) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}

export async function createOfficeOrbit(
  element,
  { url, layout, signal, visible, onRender, onLost },
) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('Office model is unavailable');
  const model = (await new GLTFLoader().parseAsync(await response.arrayBuffer(), '')).scene;
  if (signal.aborted) {
    disposeModel(model);
    signal.throwIfAborted();
  }

  let renderer;
  let controls;
  let mounted = false;
  let requestedFrame;
  let observer;
  let keydown;
  let sun;
  let detachVideo = () => {};
  const world = new Scene();
  const dispose = () => {
    detachVideo();
    if (requestedFrame !== undefined) cancelAnimationFrame(requestedFrame);
    requestedFrame = undefined;
    observer?.disconnect();
    if (keydown) element.removeEventListener('keydown', keydown);
    controls?.dispose();
    sun?.shadow.dispose();
    disposeModel(world);
    if (!mounted) disposeModel(model);
    if (renderer) {
      renderer.domElement.removeEventListener('webglcontextlost', failed);
      renderer.domElement.remove();
      renderer.dispose();
      renderer.forceContextLoss();
    }
  };

  function failed(event) {
    event?.preventDefault();
    onLost();
  }

  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: true });
    renderer.domElement.className = 'office-orbit';
    renderer.domElement.setAttribute('aria-hidden', 'true');
    renderer.domElement.addEventListener('webglcontextlost', failed);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;

    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.2, 110);
    camera.position.fromArray(layout.camera.position);
    controls = new OrbitControls(camera, element);
    controls.target.fromArray(layout.camera.target);
    controls.minPolarAngle = Math.PI / 9;
    controls.maxPolarAngle = Math.PI / 3;
    controls.enablePan = false;
    controls.enableZoom = false;
    controls.rotateSpeed = 0.62;
    controls.update();
    controls.saveState();

    world.add(model, new HemisphereLight(0xf5fbff, 0xd2c6b1, 2.0));
    mounted = true;
    sun = new DirectionalLight(0xfff3df, 1.85);
    sun.position.set(-8, 29, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1536, 1536);
    sun.shadow.camera.left = sun.shadow.camera.bottom = -15;
    sun.shadow.camera.right = sun.shadow.camera.top = 15;
    sun.shadow.camera.far = 65;
    sun.shadow.normalBias = 0.035;
    sun.shadow.radius = 4;
    world.add(sun);
    const ground = new Mesh(new PlaneGeometry(160, 160), new ShadowMaterial({ opacity: 0.09 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = layout.bounds[0][1] - 0.015;
    ground.receiveShadow = true;
    world.add(ground);

    const blockers = [];
    model.traverse((object) => {
      if (!object.isMesh) return;
      const opaque = [object.material].flat().every((material) => !material.transparent);
      object.castShadow = opaque;
      object.receiveShadow = opaque;
      if (
        opaque &&
        (object.name.startsWith(layout.occluderPrefix) ||
          object.parent?.name.startsWith(layout.occluderPrefix))
      )
        blockers.push(object);
    });
    const point = new Vector3();
    const anchors = new Map(layout.seats.map(({ id, avatar }) => [id, avatar]));
    const ndc = new Vector2();
    const ray = new Raycaster();
    const hits = [];

    let halfWidth = 1;
    let halfHeight = 1;
    let shiftX = 0;
    let shiftY = 0;
    let shown = visible;
    let projectOverlays = true;
    function project(seat, position) {
      const anchor = position ?? anchors.get(seat.id);
      if (!anchor) return null;
      point.fromArray(anchor).project(camera);
      const xPosition = (point.x + 1) / 2;
      const yPosition = (1 - point.y) / 2;
      if (xPosition < 0 || xPosition > 1 || yPosition < 0 || yPosition > 1) return null;
      ray.setFromCamera(ndc.set(point.x, point.y), camera);
      point.fromArray(anchor);
      ray.far = point.sub(ray.ray.origin).dot(ray.ray.direction) - 0.12;
      hits.length = 0;
      ray.intersectObjects(blockers, false, hits);
      return hits.length ? null : [xPosition, yPosition];
    }

    function draw() {
      requestedFrame = undefined;
      if (!shown || signal.aborted || element.clientWidth === 0 || element.clientHeight === 0)
        return;
      try {
        renderer.render(world, camera);
        if (projectOverlays) {
          projectOverlays = false;
          onRender(project);
        }
      } catch {
        failed();
      }
    }
    function invalidate(overlays = true) {
      if (overlays) projectOverlays = true;
      if (shown && requestedFrame === undefined && !signal.aborted)
        requestedFrame = requestAnimationFrame(draw);
    }

    const screenMaterial = layout.screens?.length ? new MeshBasicMaterial({ toneMapped: false }) : null;
    const screens = (layout.screens ?? []).map(({ center, size, yaw }) => {
      const mesh = new Mesh(new PlaneGeometry(...size), screenMaterial);
      mesh.position.fromArray(center);
      mesh.rotation.y = yaw;
      mesh.visible = false;
      world.add(mesh);
      return { mesh, aspect: size[0] / size[1] };
    });
    let screenVideo;
    let videoFrame;

    function cancelVideoFrame() {
      if (videoFrame !== undefined) screenVideo.cancelVideoFrameCallback(videoFrame);
      videoFrame = undefined;
    }

    function renderVideoFrames() {
      if (!shown || !screenVideo || videoFrame !== undefined || signal.aborted) return;
      videoFrame = screenVideo.requestVideoFrameCallback(() => {
        videoFrame = undefined;
        invalidate(false);
        renderVideoFrames();
      });
    }

    detachVideo = () => {
      cancelVideoFrame();
      screenMaterial?.map?.dispose();
    };

    function setScreenVideo(video) {
      if (!screenMaterial || screenVideo === video) return;
      detachVideo();
      screenVideo = video;
      const texture = video ? new VideoTexture(video) : null;
      if (texture) texture.colorSpace = SRGBColorSpace;
      screenMaterial.map = texture;
      screenMaterial.needsUpdate = true;

      const aspect = video ? video.videoWidth / video.videoHeight : 1;
      for (const screen of screens) {
        screen.mesh.visible = Boolean(video);
        screen.mesh.scale.set(Math.min(1, aspect / screen.aspect), Math.min(1, screen.aspect / aspect), 1);
      }
      invalidate(false);
      renderVideoFrames();
    }
    function updateProjection() {
      const maxX = halfWidth * (1 - 1 / camera.zoom);
      const maxY = halfHeight * (1 - 1 / camera.zoom);
      shiftX = Math.max(-maxX, Math.min(maxX, shiftX));
      shiftY = Math.max(-maxY, Math.min(maxY, shiftY));
      camera.left = shiftX - halfWidth;
      camera.right = shiftX + halfWidth;
      camera.bottom = shiftY - halfHeight;
      camera.top = shiftY + halfHeight;
      camera.updateProjectionMatrix();
      invalidate();
    }
    function resize() {
      const { clientWidth: width, clientHeight: height } = element;
      if (!width || !height) return;
      const aspect = width / height;
      halfWidth = (layout.camera.width / 2) * Math.max(1, aspect / layout.camera.aspect);
      halfHeight = halfWidth / aspect;
      renderer.setSize(width, height, false);
      updateProjection();
    }

    controls.addEventListener('change', invalidate);
    keydown = (event) => {
      if (event.target !== element || !shown) return;
      const rotation = {
        ArrowLeft: [1, 0],
        ArrowRight: [-1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      }[event.key];
      if (!rotation) return;
      event.preventDefault();
      const angle = Math.PI / 24;
      if (rotation[0]) controls.rotateLeft(angle * rotation[0]);
      else controls.rotateUp(angle * rotation[1]);
    };
    element.addEventListener('keydown', keydown);
    element.prepend(renderer.domElement);
    observer = new ResizeObserver(resize);
    observer.observe(element);
    return {
      invalidate,
      project,
      setScreenVideo,
      setVisible(value) {
        shown = value;
        controls.enabled = value;
        if (!shown && requestedFrame !== undefined) {
          cancelAnimationFrame(requestedFrame);
          requestedFrame = undefined;
        }
        if (shown) {
          resize();
          renderVideoFrames();
        } else {
          cancelVideoFrame();
        }
      },
      zoom(value, pointer) {
        if (pointer) {
          const rect = element.getBoundingClientRect();
          // Move the orthographic view without moving the point that the orbit rotates around.
          const change = 1 / camera.zoom - 1 / value;
          shiftX += (2 * ((pointer.clientX - rect.left) / rect.width) - 1) * halfWidth * change;
          shiftY += (1 - 2 * ((pointer.clientY - rect.top) / rect.height)) * halfHeight * change;
        }
        camera.zoom = value;
        updateProjection();
      },
      reset() {
        shiftX = shiftY = 0;
        controls.reset();
        updateProjection();
      },
      dispose() {
        controls.removeEventListener('change', invalidate);
        dispose();
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
