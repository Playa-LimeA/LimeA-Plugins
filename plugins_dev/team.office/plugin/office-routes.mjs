const areas = {
  A: ['A 区', 'A zone'],
  B: ['B 区', 'B zone'],
  aisle: ['主过道', 'Main aisle'],
  window: ['窗边长椅', 'Window bench'],
  pantry: ['水吧区', 'Pantry'],
  lounge: ['休闲区', 'Lounge'],
};

// Coordinates are meters in the exported model. X runs across the office and Z along it.
const spine = 0.62;
const chairAisles = [-4.58, -0.43, 0.75, 4.83];
export const activities = [
  { type: 'desk', text: ['伸个懒腰', 'Stretching a little'] },
  { type: 'desk', text: ['转两下椅子', 'Swiveling in their chair'] },
  { type: 'desk', text: ['理理桌面', 'Tidying their desk'] },
  { type: 'desk', text: ['在屏幕前发会儿呆', 'Daydreaming at their desk'] },
  { type: 'neighbor', text: ['悄悄探个头', 'Peeking around a teammate’s desk'] },
  { type: 'neighbor', text: ['路过打声招呼', 'Dropping by to say hi'] },
  { type: 'neighbor', text: ['在隔板边张望', 'Looking around by the desk divider'] },
  { type: 'neighbor', text: ['绕着工位走一圈', 'Taking a lap around the desks'] },
  { type: 'window', text: ['看看窗外', 'Looking out the window'], x: -5.7 },
  { type: 'window', text: ['坐一会儿', 'Sitting for a moment'], x: -6.2, sit: [-6.2, -5.38] },
  { type: 'window', text: ['看看绿植', 'Looking at the plants'], x: -7.4 },
  { type: 'window', text: ['晒会儿太阳', 'Taking in the sunshine'], x: -4.5 },
  { type: 'pantry', text: ['接杯水', 'Getting a glass of water'], z: -1.15 },
  { type: 'pantry', text: ['找个杯子', 'Looking for a mug'], z: -2.15 },
  { type: 'pantry', text: ['等咖啡', 'Waiting for coffee'], z: -3.2 },
  { type: 'pantry', text: ['过来续一杯', 'Refilling their coffee'], z: -2.85 },
  {
    type: 'lounge',
    text: ['在沙发上坐坐', 'Sitting on the sofa'],
    point: [6.75, 4.67],
    sit: [7.38, 4.67],
  },
  {
    type: 'lounge',
    text: ['换到单椅歇一会儿', 'Taking a break in an armchair'],
    point: [3.96, 3.72],
    sit: [3.96, 2.97],
  },
  { type: 'lounge', text: ['瞄一眼电视', 'Glancing at the TV'], point: [5.43, 2.03] },
  {
    type: 'lounge',
    text: ['在茶几旁发呆', 'Daydreaming by the coffee table'],
    point: [5.54, 4.82],
  },
  { type: 'aisle', text: ['出来走两步', 'Taking a short walk'], point: [spine, -3.53] },
  { type: 'aisle', text: ['绕过绿植矮柜', 'Walking past the planter'], point: [-0.64, 0.16] },
  {
    type: 'aisle',
    text: ['在公告板前停一会儿', 'Pausing at the noticeboard'],
    point: [-2.75, 5.19],
  },
  {
    type: 'aisle',
    text: ['慢悠悠走回工位', 'Taking the long way back to their desk'],
    point: [spine, 5.08],
    slowReturn: true,
  },
];

export const outboundActions = {
  neighbor: ['走向同事的工位', 'Walking to a teammate’s desk'],
  window: ['走向窗边长椅', 'Walking to the window bench'],
  pantry: ['走去水吧', 'Walking to the pantry'],
  lounge: ['走向休闲区', 'Walking to the lounge'],
  aisle: ['沿过道走一走', 'Taking a walk'],
};
export const returningAction = ['走回自己的工位', 'Walking back to their desk'];

function chairAisle(seat) {
  const lowerRow = Number(seat.id.slice(1)) > 3;
  return chairAisles[(seat.id.startsWith('A') ? 0 : 2) + Number(lowerRow)];
}

export function seatArea(seatId) {
  return seatId.startsWith('A') ? areas.A : areas.B;
}

export function areaAt([x, , z]) {
  if (x >= 1.57) {
    if (z >= 0.83) return areas.lounge;
    if (z >= -4.17) return areas.pantry;
  }
  if (x < -2.3 && z <= -4.83) return areas.window;
  if (x < -1.92 && z <= -0.32) return areas.A;
  if (x < -1.92 && z >= 0.64 && z <= 4.94) return areas.B;
  return areas.aisle;
}

export function makeRoute(seat, activity, neighbor) {
  const [x, y] = seat.avatar;
  const exitZ = chairAisle(seat);
  const route = [seat.avatar, [x, y, exitZ]];
  const add = (x, z) => route.push([x, y, z]);

  switch (activity.type) {
    case 'neighbor': {
      const z = chairAisle(neighbor);
      const neighborX = neighbor.avatar[0] + (neighbor.avatar[0] < x ? 0.42 : -0.42);
      // Approach the chair from its own row's aisle. Never cross the paired desks.
      if (exitZ !== z) {
        add(spine, exitZ);
        add(spine, z);
      }
      add(neighborX, z);
      break;
    }
    case 'window':
      if (exitZ !== chairAisles[0]) {
        add(spine, exitZ);
        add(spine, chairAisles[0]);
      }
      add(activity.x, chairAisles[0]);
      add(activity.x, -4.97);
      break;
    case 'pantry':
      add(spine, exitZ);
      add(spine, -1.34);
      add(3.8, -1.34);
      add(3.8, -3.63);
      add(7.25, -3.63);
      add(7.25, activity.z);
      break;
    case 'lounge': {
      const [x, z] = activity.point;
      add(spine, exitZ);
      add(spine, 3.72);
      add(2.8, 3.72);
      if (z < 3.2) {
        add(2.8, 1.87);
        add(x, 1.87);
      } else if (x > 4) {
        add(2.8, 5.53);
        add(x, 5.53);
      }
      add(x, z);
      break;
    }
    case 'aisle':
      add(spine, exitZ);
      add(spine, activity.point[1]);
      add(...activity.point);
      break;
  }

  if (activity.sit) route.push([activity.sit[0], y - 0.36, activity.sit[1]]);
  return route;
}
