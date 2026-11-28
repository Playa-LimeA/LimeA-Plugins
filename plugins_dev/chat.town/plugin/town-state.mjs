import { locations } from './locations.mjs';

const crossings = [
  ['south_crosswalk', 'crosswalk_road_south', 'crosswalk_road_north', 'north_crosswalk'],
  [
    'side_crosswalk_west',
    'side_crosswalk_road_west',
    'side_crosswalk_road_east',
    'side_crosswalk_east',
  ],
];

const crossingEdges = crossings.flatMap((points) =>
  points.slice(1).map((point, index) => [points[index], point]),
);

const pointsByScene = new Map(
  Object.entries(locations).map(([id, { visit, edges }]) => [
    id,
    new Set([visit, ...edges.flat()]),
  ]),
);

export const activityCatalog = {
  having_breakfast: {
    scene: 'home', point: 'home_breakfast', name: { zh: '正在吃早餐', en: 'Having breakfast' },
  },
  watching_tv: {
    scene: 'home', point: 'home_sofa', name: { zh: '在沙发上看电视', en: 'Watching TV on the sofa' },
  },
  resting_sofa: {
    scene: 'home', point: 'home_sofa', name: { zh: '在沙发上休息', en: 'Resting on the sofa' },
  },
  sleeping: {
    scene: 'home', point: 'home_bed', name: { zh: '正在睡觉', en: 'Sleeping' },
  },
  watching_street: {
    scene: 'home', point: 'home_balcony', name: { zh: '在阳台看街景', en: 'Watching the street from the balcony' },
  },
  using_computer: {
    scene: 'home', point: 'home_computer', name: { zh: '在电竞桌前用电脑', en: 'Using the computer' },
  },
  browsing_produce: {
    scene: 'supermarket', point: 'browse_produce', name: { zh: '正在逛生鲜区', en: 'Browsing the produce section' },
  },
  watching_water: {
    scene: 'park', point: 'park_lookout', name: { zh: '在水边看看', en: 'Watching the water' },
  },
  browsing_cafe: {
    scene: 'cafe', point: 'order_at_counter', name: { zh: '在咖啡厅吧台边看看', en: 'Looking around by the café counter' },
  },
  browsing_bread: {
    scene: 'bakery', point: 'browse_bread', name: { zh: '在面包店看今天的面包', en: 'Looking at the bread on display' },
  },
  browsing_furniture: {
    scene: 'shop', point: 'shop_sofa', name: { zh: '在家具店看沙发样品', en: 'Looking at sofas in the furniture shop' },
  },
};

export function stationaryActivity(scene, point) {
  const activity = Object.entries(activityCatalog).find(
    ([, stop]) => stop.scene === scene && stop.point === point,
  );
  return activity?.[0] ?? 'idle';
}

export function walkingActivity(scene, from, to) {
  return scene === 'street_corner' &&
    crossingEdges.some(([a, b]) => (a === from && b === to) || (a === to && b === from))
    ? 'crossing'
    : 'walking';
}

export function isTownState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  const { scene, point, activity, destination } = state;
  if (typeof activity !== 'string' || !pointsByScene.get(scene)?.has(point)) return false;
  switch (activity) {
    case 'idle':
      return destination === undefined;
    case 'walking':
      return destination === undefined || pointsByScene.has(destination);
    case 'crossing':
      return (
        scene === 'street_corner' &&
        (destination === undefined || pointsByScene.has(destination)) &&
        crossingEdges.some((edge) => edge.includes(point))
      );
    default:
      return (
        destination === undefined &&
        Object.hasOwn(activityCatalog, activity) &&
        activityCatalog[activity].scene === scene &&
        activityCatalog[activity].point === point
      );
  }
}
