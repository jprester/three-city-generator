import { Color, MathUtils, Vector3 } from 'three';

// palette anchors for the procedural sky
const NIGHT = { top: 0x05060a, horizon: 0x10131c, bottom: 0x080a10 };
const DAY = { top: 0x244a8c, horizon: 0xa6c6ef, bottom: 0x8fa6bd };
const SUNSET = 0xff7a3c;

const _a = new Color();
const _b = new Color();
const lerpHex = (a, b, t) => _a.setHex(a).lerp(_b.setHex(b), t).getHex();

/**
 * Maps a 0..24 time of day to everything the lab's lighting needs — sky gradient
 * colours, sun direction/colour/intensity, the fraction of rooms with the lights
 * on, and an ambient level. Pure function, no assets: night is dark with many
 * lit windows; midday is bright with almost none; dusk warms the horizon.
 */
export function skyForTime(t) {
  // sun height: -1 at midnight, 0 at sunrise/sunset (6/18), +1 at noon
  const s = Math.sin(((t - 6) / 12) * Math.PI);
  const day = MathUtils.clamp(s, 0, 1);

  // warm glow that peaks when the sun is low, biased to the evening
  const lowSun = Math.max(0, 1 - Math.abs(s) * 3);
  const sunset = lowSun * (t > 12 ? 1 : 0.55);

  const top = lerpHex(NIGHT.top, DAY.top, day);
  const bottom = lerpHex(NIGHT.bottom, DAY.bottom, day);
  let horizon = lerpHex(NIGHT.horizon, DAY.horizon, day);
  horizon = lerpHex(horizon, SUNSET, sunset * 0.7);

  // sun arc (mirrors the city example's mapping)
  const elevation = s * 70; // degrees; negative when below the horizon
  const azimuth = 90 - ((t - 12) / 6) * 55;
  const dir = new Vector3().setFromSphericalCoords(
    1,
    MathUtils.degToRad(90 - elevation),
    MathUtils.degToRad(azimuth)
  );

  return {
    top,
    horizon,
    bottom,
    sunDir: [dir.x, dir.y, dir.z],
    sunColor: _a.setHex(0xffb072).lerp(_b.setHex(0xfff4e8), day).getHex(),
    sunIntensity: Math.max(0, s) * 2.4,
    litFraction: MathUtils.lerp(0.75, 0.04, day), // many lit at night, few by day
    ambient: 0.12 + day * 0.5,
  };
}
