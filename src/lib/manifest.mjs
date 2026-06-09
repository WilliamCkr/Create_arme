export function frameFileNameForAngle(angle) {
  const safeAngle = Number(angle);
  const padded = String(safeAngle).padStart(3, "0");
  return `angle_${padded}.png`;
}

export function buildWeaponManifest({ config }) {
  const frames = config.angles.map((angle, index) => ({
    angle,
    frame: index,
    src: `frames/${frameFileNameForAngle(angle)}`
  }));

  return {
    id: config.id,
    name: config.name,
    kind: config.kind,
    weaponType: config.weaponType,
    angleProfile: `weapon_${frames.length}_full_rotation`,
    atlas: "atlas.png",
    frameSize: config.frameSize,
    pivot: config.pivot,
    angleFrames: frames
  };
}

export function requiredManifestFields() {
  return ["id", "name", "kind", "weaponType", "angleProfile", "atlas", "frameSize", "pivot", "angleFrames"];
}
