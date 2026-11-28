import { Color, DirectionalLight, HemisphereLight, Vector3 } from './vendor/three-town.mjs';

function preset(values) {
  return {
    ...values,
    background: new Color(values.background),
    skyColor: new Color(values.skyColor),
    groundColor: new Color(values.groundColor),
    sunColor: new Color(values.sunColor),
    sunPosition: new Vector3(...values.sunPosition),
    fillColor: new Color(values.fillColor),
  };
}

const morning = preset({
  background: 0xeadbc7,
  skyColor: 0xffe9ce,
  groundColor: 0xb6a794,
  ambientIntensity: 1.75,
  sunColor: 0xffd6a0,
  sunIntensity: 1.55,
  sunPosition: [-9, 4.5, 6],
  fillColor: 0xe5efff,
  fillIntensity: 0.53,
  exposure: 1.07,
});

const noon = preset({
  background: 0xe7ddd0,
  skyColor: 0xfff4e8,
  groundColor: 0xa9a590,
  ambientIntensity: 2,
  sunColor: 0xfff0db,
  sunIntensity: 1.8,
  sunPosition: [-5, 9, 5],
  fillColor: 0xe7f3ff,
  fillIntensity: 0.58,
  exposure: 1.1,
});

const afternoon = preset({
  background: 0xe6cabb,
  skyColor: 0xffdfc7,
  groundColor: 0xa38a80,
  ambientIntensity: 1.53,
  sunColor: 0xffb981,
  sunIntensity: 1.55,
  sunPosition: [8, 4.5, -2],
  fillColor: 0xdbe9ff,
  fillIntensity: 0.58,
  exposure: 1.07,
});

const night = preset({
  background: 0x343e54,
  skyColor: 0xb5cbf0,
  groundColor: 0x737d9d,
  ambientIntensity: 1.17,
  sunColor: 0xadc9ff,
  sunIntensity: 0.4,
  sunPosition: [-3, 8, -7],
  fillColor: 0xffc88f,
  fillIntensity: 0.99,
  exposure: 1.04,
});

const timeline = [
  [0, night],
  [5 * 60, night],
  [7 * 60 + 30, morning],
  [12 * 60, noon],
  [16 * 60 + 45, afternoon],
  [20 * 60 + 30, night],
  [24 * 60, night],
];

function interpolate(from, to, blend) {
  return from + (to - from) * blend;
}

export function makeTownLighting(scene, renderer) {
  const background = new Color();
  scene.background = background;
  const ambient = new HemisphereLight();
  const sun = new DirectionalLight();
  const fill = new DirectionalLight();
  fill.position.set(5, 4, -6);
  scene.add(ambient, sun, fill);

  function apply(from, to, blend) {
    background.lerpColors(from.background, to.background, blend);
    ambient.color.lerpColors(from.skyColor, to.skyColor, blend);
    ambient.groundColor.lerpColors(from.groundColor, to.groundColor, blend);
    ambient.intensity = interpolate(from.ambientIntensity, to.ambientIntensity, blend);
    sun.color.lerpColors(from.sunColor, to.sunColor, blend);
    sun.intensity = interpolate(from.sunIntensity, to.sunIntensity, blend);
    sun.position.lerpVectors(from.sunPosition, to.sunPosition, blend);
    fill.color.lerpColors(from.fillColor, to.fillColor, blend);
    fill.intensity = interpolate(from.fillIntensity, to.fillIntensity, blend);
    renderer.toneMappingExposure = interpolate(from.exposure, to.exposure, blend);
  }

  apply(noon, noon, 0);
  let previousMinute;
  let steadyPreset = noon;

  return (time) => {
    if (!time) return false;
    const minute = time.getHours() * 60 + time.getMinutes();
    if (!Number.isInteger(minute) || minute === previousMinute) return false;
    previousMinute = minute;

    const nextIndex = timeline.findIndex(([at]) => at > minute);
    const [start, from] = timeline[nextIndex - 1];
    const [end, to] = timeline[nextIndex];
    const steady = minute === start || from === to ? from : undefined;
    if (steady && steady === steadyPreset) return false;
    steadyPreset = steady;

    const progress = (minute - start) / (end - start);
    const blend = progress * progress * (3 - 2 * progress);
    apply(from, to, blend);
    return true;
  };
}
