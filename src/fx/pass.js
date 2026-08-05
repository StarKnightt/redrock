/**
 * Keep effect geometry out of scene-wide override passes.
 *
 * The ink pipeline replaces every material for its normals/depth render, so
 * flags on a transparent material cannot opt it out. Collapsing the draw range
 * only while an override is active leaves the beauty pass untouched and stops
 * billboard silhouettes from becoming solid depth edges.
 */
export function skipOverridePass(object) {
  let suppressed = false;
  let start = 0;
  let count = 0;

  object.userData.fxOverrideSkips = 0;
  object.onBeforeRender = (_renderer, scene, _camera, geometry) => {
    if (!scene.overrideMaterial || suppressed) return;
    start = geometry.drawRange.start;
    count = geometry.drawRange.count;
    geometry.drawRange.count = 0;
    suppressed = true;
    object.userData.fxOverrideSkips++;
  };
  object.onAfterRender = (_renderer, _scene, _camera, geometry) => {
    if (!suppressed) return;
    geometry.drawRange.start = start;
    geometry.drawRange.count = count;
    suppressed = false;
  };
}
