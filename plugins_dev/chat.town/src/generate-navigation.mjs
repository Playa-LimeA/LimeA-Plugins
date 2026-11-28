import { readFile, writeFile } from 'node:fs/promises';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { destinationOrder, locations } from '../plugin/locations.mjs';
import { getPortal, nextStop } from '../plugin/routes.mjs';

function parseGlb(payload) {
  if (
    payload.length < 20 ||
    payload.toString('ascii', 0, 4) !== 'glTF' ||
    payload.readUInt32LE(4) !== 2 ||
    payload.readUInt32LE(8) !== payload.length ||
    payload.toString('ascii', 16, 20) !== 'JSON'
  ) {
    throw new Error('Invalid glTF binary header');
  }
  const end = 20 + payload.readUInt32LE(12);
  if (end > payload.length) throw new Error('Truncated glTF JSON chunk');
  return JSON.parse(payload.toString('utf8', 20, end));
}

export function markerNavigation(document, scene) {
  const points = new Map();

  function visit(index, parent) {
    const node = document.nodes[index];
    const local = node.matrix
      ? new Matrix4().fromArray(node.matrix)
      : new Matrix4().compose(
          new Vector3().fromArray(node.translation ?? [0, 0, 0]),
          new Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]),
          new Vector3().fromArray(node.scale ?? [1, 1, 1]),
        );
    const world = new Matrix4().multiplyMatrices(parent, local);
    const marker = node.extras;
    if (marker?.scene_id === scene && typeof marker.point_id === 'string') {
      const point = marker.point_id;
      if (points.has(point)) throw new Error(`Duplicate route marker ${scene}/${point}`);
      const position = new Vector3().setFromMatrixPosition(world).toArray().map((value) =>
        Number(value.toFixed(6)),
      );
      if (position.some((value) => !Number.isFinite(value))) {
        throw new Error(`Invalid route position ${scene}/${point}`);
      }
      points.set(point, {
        position,
        ...(typeof marker.target_scene === 'string' ? { target_scene: marker.target_scene } : {}),
        ...(typeof marker.arrival_point === 'string' ? { arrival_point: marker.arrival_point } : {}),
        ...(marker.connection_ready === false ? { connection_ready: false } : {}),
      });
    }
    for (const child of node.children ?? []) visit(child, world);
  }

  const identity = new Matrix4();
  for (const node of document.scenes[document.scene ?? 0].nodes ?? []) visit(node, identity);
  return points;
}

export async function readNavigation() {
  const scenes = new Map();
  for (const scene of destinationOrder) {
    const payload = await readFile(new URL(`../plugin/assets/${scene}.glb`, import.meta.url));
    const points = markerNavigation(parseGlb(payload), scene);
    for (const point of [locations[scene].visit, ...locations[scene].edges.flat()]) {
      if (!points.has(point)) throw new Error(`Missing route marker ${scene}/${point}`);
    }
    scenes.set(scene, points);
  }

  for (const [scene, points] of scenes) {
    for (const destination of destinationOrder) {
      const step = nextStop(locations, scene, destination);
      if (!step.next) continue;
      const arrival = getPortal(points, step.point, step.next);
      if (!scenes.get(step.next).has(arrival)) {
        throw new Error(`Missing portal arrival ${step.next}/${arrival}`);
      }
    }
  }

  return Object.fromEntries(
    [...scenes].map(([scene, points]) => [scene, Object.fromEntries([...points].sort())]),
  );
}

export async function generateNavigation() {
  const scenes = await readNavigation();
  const rows = Object.entries(scenes).map(([scene, points]) => {
    const markers = Object.entries(points).map(([key, point]) =>
      `    ${JSON.stringify(key)}: ${JSON.stringify(point)},`,
    );
    return [`  ${JSON.stringify(scene)}: {`, ...markers, '  },'].join('\n');
  });
  await writeFile(
    new URL('../plugin/navigation.mjs', import.meta.url),
    `// Generated from scene GLB files by npm run build.\nexport const navigation = {\n${rows.join('\n')}\n};\n`,
  );
}
