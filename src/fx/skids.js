import * as THREE from 'three';
import { rng, rand } from '../core/rng.js';
import { skipOverridePass } from './pass.js';

const VERT = /* glsl */`
attribute float aBirth;
attribute float aStrength;

uniform float uTime;
varying float vAge;
varying float vStrength;
varying float vBirth;
varying vec2 vUv;

void main() {
  vAge = uTime - aBirth;
  vStrength = aStrength;
  vBirth = aBirth;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */`
precision highp float;

uniform float uLifetime;
uniform vec3 uCore;
uniform vec3 uEdge;
varying float vAge;
varying float vStrength;
varying float vBirth;
varying vec2 vUv;

void main() {
  if (vAge < 0.0 || vAge >= uLifetime) discard;
  float fade = 1.0 - smoothstep(uLifetime * 0.58, uLifetime, vAge);
  float distanceAcross = abs(vUv.y - 0.5);
  float edge = 0.43;
  float aa = max(fwidth(distanceAcross) * 1.35, 0.002);
  float coverage = 1.0 - smoothstep(edge - aa, edge + aa, distanceAcross);
  if (coverage <= 0.001) discard;
  float core = 1.0 - smoothstep(0.25, 0.33, distanceAcross);
  vec3 color = mix(uEdge, uCore, core);
  gl_FragColor = vec4(color, max(0.92, vStrength) * fade * coverage);
}`;

/**
 * Dynamic quad strips in a fixed ring.
 *
 * One mesh is cheaper than a decal object per tyre sample, and overwriting the
 * oldest segment gives a hard memory bound on a stage long enough to run for
 * minutes.
 */
export class SkidMarks {
  constructor(parent, { max = 720, lifetime = 14, seed = 1 } = {}) {
    this.max = Math.max(32, max | 0);
    this.lifetime = lifetime;
    this.seed = seed | 0;
    this.cursor = 0;
    this.live = 0;
    this.dirty = false;
    this.random = rand(rng(this.seed + 2053));

    const vertices = this.max * 4;
    this.positions = new Float32Array(vertices * 3);
    this.births = new Float32Array(vertices);
    this.strengths = new Float32Array(vertices);
    this.births.fill(-1e6);

    const uvs = new Float32Array(vertices * 2);
    const indices = new Uint32Array(this.max * 6);
    for (let i = 0; i < this.max; i++) {
      const v = i * 4, u = v * 2, x = i * 6;
      uvs[u] = 0; uvs[u + 1] = 0;
      uvs[u + 2] = 0; uvs[u + 3] = 1;
      uvs[u + 4] = 1; uvs[u + 5] = 0;
      uvs[u + 6] = 1; uvs[u + 7] = 1;
      indices[x] = v; indices[x + 1] = v + 2; indices[x + 2] = v + 1;
      indices[x + 3] = v + 1; indices[x + 4] = v + 2; indices[x + 5] = v + 3;
    }

    const geometry = new THREE.BufferGeometry();
    this.positionAttr = new THREE.BufferAttribute(this.positions, 3);
    this.birthAttr = new THREE.BufferAttribute(this.births, 1);
    this.strengthAttr = new THREE.BufferAttribute(this.strengths, 1);
    geometry.setAttribute('position', this.positionAttr);
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute('aBirth', this.birthAttr);
    geometry.setAttribute('aStrength', this.strengthAttr);
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.setDrawRange(0, indices.length);

    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uLifetime: { value: lifetime },
        uCore: { value: new THREE.Color(0x10080c) },
        uEdge: { value: new THREE.Color(0x1a0e12) },
      },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      toneMapped: false,
      extensions: { derivatives: true },
    });
    material.forceSinglePass = true;

    this.geometry = geometry;
    this.material = material;
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'fx-skid-ring';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
    skipOverridePass(this.mesh);
    parent.add(this.mesh);
  }

  add(a, b, sideA, sideB, width, strength, time) {
    const i = this.cursor;
    this.cursor = (i + 1) % this.max;
    const q = this.random;
    /* Matching edge widths at both ends lets adjacent ring segments meet as
       one tyre streak instead of exposing a repeating sawtooth join. */
    const halfA = width * 0.5;
    const halfB = width * 0.5;
    const v = i * 4, p = v * 3;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const extension = Math.min(0.055, length * 0.22);
    const scale = length > 1e-5 ? extension / length : 0;
    const ax = a.x - dx * scale, ay = a.y - dy * scale, az = a.z - dz * scale;
    const bx = b.x + dx * scale, by = b.y + dy * scale, bz = b.z + dz * scale;

    this.positions[p] = ax - sideA.x * halfA;
    this.positions[p + 1] = ay - sideA.y * halfA;
    this.positions[p + 2] = az - sideA.z * halfA;
    this.positions[p + 3] = ax + sideA.x * halfA;
    this.positions[p + 4] = ay + sideA.y * halfA;
    this.positions[p + 5] = az + sideA.z * halfA;
    this.positions[p + 6] = bx - sideB.x * halfB;
    this.positions[p + 7] = by - sideB.y * halfB;
    this.positions[p + 8] = bz - sideB.z * halfB;
    this.positions[p + 9] = bx + sideB.x * halfB;
    this.positions[p + 10] = by + sideB.y * halfB;
    this.positions[p + 11] = bz + sideB.z * halfB;

    const value = strength * q.f(0.88, 1.0);
    for (let k = 0; k < 4; k++) {
      this.births[v + k] = time;
      this.strengths[v + k] = value;
    }
    this.dirty = true;
    this.mesh.visible = true;
  }

  update(time) {
    this.material.uniforms.uTime.value = time;
    let live = 0;
    for (let i = 0; i < this.max; i++) {
      const age = time - this.births[i * 4];
      if (age >= 0 && age < this.lifetime) live++;
    }
    this.live = live;
    this.mesh.visible = live > 0;
    if (!this.dirty) return;
    this.positionAttr.needsUpdate = true;
    this.birthAttr.needsUpdate = true;
    this.strengthAttr.needsUpdate = true;
    this.dirty = false;
  }

  reset() {
    this.births.fill(-1e6);
    this.strengths.fill(0);
    this.cursor = 0;
    this.live = 0;
    this.mesh.visible = false;
    this.random = rand(rng(this.seed + 2053));
    this.birthAttr.needsUpdate = true;
    this.strengthAttr.needsUpdate = true;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
