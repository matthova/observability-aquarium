import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import aquariumConfig from "./aquarium-config.json";
import "./styles.css";

const canvas = document.querySelector("#aquarium");
const fishInspector = document.querySelector("#fish-inspector");
const selectedFishName = document.querySelector("#selected-fish-name");
const selectedFishType = document.querySelector("#selected-fish-type");
const selectedFishSize = document.querySelector("#selected-fish-size");

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  preserveDrawingBuffer: true,
  powerPreference: "high-performance",
});

renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x0b5268, 0.033);

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  150,
);
camera.position.set(0, 6.5, 22);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.22;
controls.minDistance = 11;
controls.maxDistance = 32;
controls.maxPolarAngle = Math.PI * 0.56;
controls.minPolarAngle = Math.PI * 0.22;
controls.target.set(0, 2.2, 0);

const clock = new THREE.Clock();
const tank = {
  width: 26,
  height: 14,
  depth: 18,
  floor: -5.2,
  surface: 8.1,
};

const updatables = [];
const mouse = new THREE.Vector2();
const clickPointer = new THREE.Vector2();
const pointerDownPosition = new THREE.Vector2();
const tmpVec = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
const selectableFish = [];
const fishHitTargets = [];
let selectedFish = null;
let hasPointerDown = false;
let suppressNextClick = false;

const palette = {
  waterA: new THREE.Color(0x143f55),
  waterB: new THREE.Color(0x071d2a),
  caustic: new THREE.Color(0xb9fff2),
  sand: new THREE.Color(0xd9be83),
};

const random = mulberry32(29);

function mulberry32(seed) {
  return function next() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rand(min, max) {
  return min + (max - min) * random();
}

function choice(items) {
  return items[Math.floor(random() * items.length)];
}

function configuredNumber(value, fallback = 0) {
  if (Array.isArray(value) && value.length >= 2) return rand(Number(value[0]), Number(value[1]));
  if (Number.isFinite(value)) return value;
  return fallback;
}

function configuredVector(value, fallback = new THREE.Vector3()) {
  if (!value) return fallback.clone();
  return new THREE.Vector3(
    configuredNumber(value.x, fallback.x),
    configuredNumber(value.y, fallback.y),
    configuredNumber(value.z, fallback.z),
  );
}

function humanizeId(value = "") {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function createSelectionHalo() {
  const group = new THREE.Group();
  const gold = new THREE.MeshBasicMaterial({
    color: 0xffcf6a,
    transparent: true,
    opacity: 0.88,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const cyan = new THREE.MeshBasicMaterial({
    color: 0x8ff8ff,
    transparent: true,
    opacity: 0.34,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  const outer = new THREE.Mesh(new THREE.TorusGeometry(0.92, 0.018, 10, 96), gold);
  const inner = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.012, 10, 96), cyan);
  const pulse = new THREE.Mesh(new THREE.TorusGeometry(1.12, 0.01, 10, 96), cyan.clone());
  group.add(outer, inner, pulse);
  group.visible = false;
  group.userData.pulse = pulse;
  scene.add(group);
  return group;
}

const selectionHalo = createSelectionHalo();

function createNoiseTexture(size = 256) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const waves =
        Math.sin(x * 0.18) * 0.18 +
        Math.sin((x + y) * 0.07) * 0.17 +
        Math.cos(y * 0.11) * 0.12;
      const speckle = random() * 0.62;
      const value = Math.floor((0.38 + waves + speckle) * 255);
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createCausticTexture(size = 256) {
  const canvasTexture = document.createElement("canvas");
  canvasTexture.width = size;
  canvasTexture.height = size;
  const ctx = canvasTexture.getContext("2d");
  const image = ctx.createImageData(size, size);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const lineA = Math.abs(Math.sin((u * 7.0 + Math.sin(v * 8.0) * 0.24) * Math.PI));
      const lineB = Math.abs(Math.sin((v * 8.5 + Math.cos(u * 5.0) * 0.28) * Math.PI));
      const lineC = Math.abs(Math.sin(((u + v) * 5.4 + Math.sin(u * 10.0) * 0.18) * Math.PI));
      const glow = Math.pow(Math.max(lineA, lineB, lineC), 10);
      const vein = Math.pow((lineA + lineB + lineC) / 3, 22);
      const alpha = Math.floor(Math.min(1, glow * 0.42 + vein * 0.88) * 255);
      const i = (y * size + x) * 4;
      image.data[i] = 190;
      image.data[i + 1] = 255;
      image.data[i + 2] = 239;
      image.data[i + 3] = alpha;
    }
  }

  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvasTexture);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function makeCanvasLabelTexture(text, width = 420, height = 110) {
  const labelCanvas = document.createElement("canvas");
  labelCanvas.width = width;
  labelCanvas.height = height;
  const ctx = labelCanvas.getContext("2d");

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(9, 31, 39, 0.72)";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(207, 248, 255, 0.45)";
  ctx.lineWidth = 4;
  ctx.strokeRect(8, 8, width - 16, height - 16);
  ctx.fillStyle = "#dffbff";
  ctx.font = "700 42px Inter, Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, width / 2, height / 2 - 2);
  ctx.fillStyle = "rgba(255, 209, 122, 0.95)";
  ctx.font = "600 18px Inter, Arial, sans-serif";
  ctx.fillText("REEF HABITAT", width / 2, height - 24);

  const texture = new THREE.CanvasTexture(labelCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function addLighting() {
  const ambient = new THREE.HemisphereLight(0xa4f0ff, 0x0b1f24, 1.25);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xd2fcff, 3.2);
  key.position.set(-8, 14, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 2;
  key.shadow.camera.far = 40;
  key.shadow.camera.left = -18;
  key.shadow.camera.right = 18;
  key.shadow.camera.top = 18;
  key.shadow.camera.bottom = -18;
  scene.add(key);

  const warm = new THREE.PointLight(0xffb35c, 1.2, 18, 1.8);
  warm.position.set(8, 1.8, -5);
  scene.add(warm);

  const cyan = new THREE.PointLight(0x53dcff, 1.4, 24, 1.5);
  cyan.position.set(-8, 5, 5);
  scene.add(cyan);

  const movingSpot = new THREE.SpotLight(0xcffffa, 3.6, 35, Math.PI / 5, 0.65, 1.1);
  movingSpot.position.set(0, 12, 4);
  movingSpot.target.position.set(0, tank.floor, 0);
  movingSpot.castShadow = true;
  scene.add(movingSpot.target, movingSpot);

  updatables.push((time) => {
    movingSpot.position.x = Math.sin(time * 0.28) * 6;
    movingSpot.position.z = 3 + Math.cos(time * 0.2) * 4;
    movingSpot.target.position.set(Math.sin(time * 0.16) * 3, tank.floor, Math.cos(time * 0.21) * 3);
  });
}

function createWaterVolume() {
  const uniforms = {
    time: { value: 0 },
    topColor: { value: new THREE.Color(0x2bc2d4) },
    bottomColor: { value: new THREE.Color(0x03121c) },
  };

  const geometry = new THREE.SphereGeometry(74, 64, 32);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms,
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform float time;
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      varying vec3 vWorldPosition;

      float band(float v, float strength) {
        return sin(v * 16.0 + time * strength) * 0.5 + 0.5;
      }

      void main() {
        float h = clamp((vWorldPosition.y + 18.0) / 46.0, 0.0, 1.0);
        vec3 color = mix(bottomColor, topColor, pow(h, 1.25));
        float shafts = pow(band(vWorldPosition.x * 0.08 + vWorldPosition.z * 0.04, 0.55), 8.0) * 0.08;
        float depth = smoothstep(-18.0, 20.0, vWorldPosition.z);
        color += vec3(0.18, 0.45, 0.48) * shafts * (1.0 - depth);
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });

  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  updatables.push((time) => {
    uniforms.time.value = time;
  });
}

function createTank() {
  const wallMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xc9fbff,
    transparent: true,
    opacity: 0.12,
    roughness: 0.04,
    metalness: 0,
    transmission: 0.55,
    thickness: 0.18,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const frontBackGeo = new THREE.PlaneGeometry(tank.width, tank.height);
  const sideGeo = new THREE.PlaneGeometry(tank.depth, tank.height);

  const back = new THREE.Mesh(frontBackGeo, wallMaterial);
  back.position.set(0, 1.5, -tank.depth / 2);
  scene.add(back);

  const front = new THREE.Mesh(frontBackGeo, wallMaterial.clone());
  front.position.set(0, 1.5, tank.depth / 2);
  front.rotation.y = Math.PI;
  front.material.opacity = 0.06;
  scene.add(front);

  const left = new THREE.Mesh(sideGeo, wallMaterial.clone());
  left.position.set(-tank.width / 2, 1.5, 0);
  left.rotation.y = Math.PI / 2;
  left.material.opacity = 0.1;
  scene.add(left);

  const right = new THREE.Mesh(sideGeo, wallMaterial.clone());
  right.position.set(tank.width / 2, 1.5, 0);
  right.rotation.y = -Math.PI / 2;
  right.material.opacity = 0.1;
  scene.add(right);

  const waterSurface = createWaterSurface();
  waterSurface.position.y = tank.surface;
  scene.add(waterSurface);

  const edgeMaterial = new THREE.LineBasicMaterial({
    color: 0xb6fbff,
    transparent: true,
    opacity: 0.34,
  });
  const points = [
    [-tank.width / 2, tank.floor, -tank.depth / 2],
    [tank.width / 2, tank.floor, -tank.depth / 2],
    [tank.width / 2, tank.surface, -tank.depth / 2],
    [-tank.width / 2, tank.surface, -tank.depth / 2],
    [-tank.width / 2, tank.floor, -tank.depth / 2],
    [-tank.width / 2, tank.floor, tank.depth / 2],
    [tank.width / 2, tank.floor, tank.depth / 2],
    [tank.width / 2, tank.surface, tank.depth / 2],
    [-tank.width / 2, tank.surface, tank.depth / 2],
    [-tank.width / 2, tank.floor, tank.depth / 2],
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z));

  const rearTop = [
    [tank.width / 2, tank.floor, -tank.depth / 2],
    [tank.width / 2, tank.floor, tank.depth / 2],
    [tank.width / 2, tank.surface, tank.depth / 2],
    [tank.width / 2, tank.surface, -tank.depth / 2],
    [-tank.width / 2, tank.surface, -tank.depth / 2],
    [-tank.width / 2, tank.surface, tank.depth / 2],
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z));

  const edgeGeometry = new THREE.BufferGeometry().setFromPoints([...points, ...rearTop]);
  scene.add(new THREE.Line(edgeGeometry, edgeMaterial));

  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(3.9, 1.02),
    new THREE.MeshBasicMaterial({
      map: makeCanvasLabelTexture("Ocean Atrium"),
      transparent: true,
      opacity: 0.78,
    }),
  );
  label.position.set(-8.3, -3.75, tank.depth / 2 + 0.03);
  label.rotation.y = Math.PI;
  scene.add(label);
}

function createWaterSurface() {
  const uniforms = {
    time: { value: 0 },
    colorA: { value: new THREE.Color(0x69eeff) },
    colorB: { value: new THREE.Color(0x0e667b) },
  };
  const geometry = new THREE.PlaneGeometry(tank.width, tank.depth, 90, 70);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms,
    vertexShader: `
      uniform float time;
      varying vec2 vUv;
      varying float vWave;
      void main() {
        vUv = uv;
        vec3 p = position;
        float wave =
          sin((p.x * 0.62 + time * 0.9)) * 0.08 +
          cos((p.y * 0.78 - time * 0.7)) * 0.06 +
          sin((p.x + p.y) * 0.4 + time * 0.45) * 0.05;
        p.z += wave;
        vWave = wave;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 colorA;
      uniform vec3 colorB;
      varying vec2 vUv;
      varying float vWave;
      void main() {
        vec2 grid = abs(fract(vUv * 9.0 - 0.5) - 0.5) / fwidth(vUv * 9.0);
        float line = 1.0 - min(min(grid.x, grid.y), 1.0);
        vec3 color = mix(colorB, colorA, smoothstep(-0.1, 0.1, vWave));
        float alpha = 0.18 + line * 0.18;
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  updatables.push((time) => {
    uniforms.time.value = time;
  });
  return mesh;
}

function createSandBed() {
  const sandTexture = createNoiseTexture(192);
  sandTexture.repeat.set(5, 4);

  const geometry = new THREE.PlaneGeometry(tank.width, tank.depth, 180, 130);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const ridge =
      Math.sin(x * 2.2 + y * 0.35) * 0.12 +
      Math.sin((x + y) * 0.78) * 0.08 +
      Math.cos(y * 2.8) * 0.045;
    const basin = -Math.pow(Math.abs(x) / (tank.width / 2), 3) * 0.45;
    const mound = Math.exp(-((x + 4) ** 2 + (y + 2) ** 2) / 42) * 0.58;
    position.setZ(i, ridge + basin + mound);
  }
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    color: palette.sand,
    map: sandTexture,
    roughness: 0.92,
    metalness: 0,
  });

  const sand = new THREE.Mesh(geometry, material);
  sand.rotation.x = -Math.PI / 2;
  sand.position.y = tank.floor;
  sand.receiveShadow = true;
  scene.add(sand);

  const causticTexture = createCausticTexture();
  causticTexture.repeat.set(3.5, 2.5);

  const causticMaterial = new THREE.MeshBasicMaterial({
    color: 0xcffff1,
    map: causticTexture,
    transparent: true,
    opacity: 0.26,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const caustics = new THREE.Mesh(new THREE.PlaneGeometry(tank.width, tank.depth), causticMaterial);
  caustics.rotation.x = -Math.PI / 2;
  caustics.position.y = tank.floor + 0.055;
  scene.add(caustics);

  updatables.push((time) => {
    causticTexture.offset.x = Math.sin(time * 0.08) * 0.08 + time * 0.012;
    causticTexture.offset.y = Math.cos(time * 0.07) * 0.07 - time * 0.01;
    causticMaterial.opacity = 0.22 + Math.sin(time * 1.35) * 0.045;
  });
}

function createIrregularRock(radius = 1, color = 0x5a6461) {
  const geometry = new THREE.IcosahedronGeometry(radius, 3);
  const position = geometry.attributes.position;
  const normal = new THREE.Vector3();
  for (let i = 0; i < position.count; i += 1) {
    normal.fromBufferAttribute(position, i).normalize();
    const wobble =
      1 +
      Math.sin(normal.x * 8.1 + normal.z * 3.4) * 0.12 +
      Math.cos(normal.y * 7.3) * 0.11 +
      rand(-0.06, 0.08);
    position.setXYZ(i, position.getX(i) * wobble, position.getY(i) * wobble, position.getZ(i) * wobble);
  }
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.88,
    metalness: 0.02,
  });
  const rock = new THREE.Mesh(geometry, material);
  rock.castShadow = true;
  rock.receiveShadow = true;
  return rock;
}

function createHardscape() {
  const reefGroup = new THREE.Group();
  scene.add(reefGroup);

  const rocks = [
    [-7.6, tank.floor + 0.7, -4.8, 1.9, 0x596965],
    [-5.2, tank.floor + 0.4, -3.8, 1.25, 0x68746a],
    [-2.6, tank.floor + 0.6, -5.2, 1.45, 0x4f5c59],
    [5.8, tank.floor + 0.65, -4.7, 1.7, 0x5c6058],
    [8.1, tank.floor + 0.42, -3.3, 1.05, 0x70705f],
    [3.3, tank.floor + 0.32, 3.4, 0.85, 0x5a6761],
    [-8.4, tank.floor + 0.28, 3.8, 0.85, 0x6d7168],
  ];

  rocks.forEach(([x, y, z, s, color]) => {
    const rock = createIrregularRock(s, color);
    rock.position.set(x, y, z);
    rock.scale.set(rand(1, 1.65), rand(0.58, 1.15), rand(0.8, 1.45));
    rock.rotation.set(rand(-0.15, 0.25), rand(0, Math.PI), rand(-0.12, 0.18));
    reefGroup.add(rock);
  });

  createCoralGarden(reefGroup);
  createKelpForest();
  createStarfish();
  createShells();
}

function createCoralGarden(parent) {
  const clusters = [
    [-7.8, tank.floor + 1.1, -3.7, "stag", 0xff6f74],
    [-5.2, tank.floor + 0.85, -4.1, "fan", 0xffb357],
    [-2.5, tank.floor + 0.98, -5.2, "brain", 0xdf8aee],
    [5.8, tank.floor + 1.02, -4.2, "stag", 0x4ee8bd],
    [7.8, tank.floor + 0.84, -2.9, "fan", 0xf36ea9],
    [1.6, tank.floor + 0.42, 3.6, "anemone", 0xffc85d],
    [-7.8, tank.floor + 0.38, 3.4, "anemone", 0x8fe9ff],
    [3.9, tank.floor + 0.58, -5.4, "brain", 0x8dd966],
  ];

  clusters.forEach(([x, y, z, type, color]) => {
    let coral;
    if (type === "stag") coral = createStaghornCoral(color);
    if (type === "fan") coral = createFanCoral(color);
    if (type === "brain") coral = createBrainCoral(color);
    if (type === "anemone") coral = createAnemone(color);
    coral.position.set(x, y, z);
    coral.rotation.y = rand(-0.5, 0.5);
    parent.add(coral);
  });
}

function createStaghornCoral(color) {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.56,
    metalness: 0.02,
  });

  const branchCount = 18;
  for (let i = 0; i < branchCount; i += 1) {
    const angle = (i / branchCount) * Math.PI * 2 + rand(-0.2, 0.2);
    const height = rand(0.85, 2.2);
    const radius = rand(0.08, 0.16);
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(Math.cos(angle) * rand(0.2, 0.5), height * 0.42, Math.sin(angle) * rand(0.2, 0.5)),
      new THREE.Vector3(Math.cos(angle) * rand(0.45, 1.1), height, Math.sin(angle) * rand(0.45, 1.1)),
    ]);
    const tube = new THREE.TubeGeometry(curve, 14, radius, 8, false);
    const mesh = new THREE.Mesh(tube, material);
    mesh.castShadow = true;
    group.add(mesh);

    if (random() > 0.38) {
      const tip = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.35, 10, 8), material);
      tip.position.copy(curve.points[curve.points.length - 1]);
      group.add(tip);
    }
  }

  return group;
}

function createFanCoral(color) {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.46,
    metalness: 0,
    transparent: true,
    opacity: 0.86,
    side: THREE.DoubleSide,
  });
  const ribMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color).offsetHSL(0, -0.08, -0.18),
    roughness: 0.55,
  });

  for (let i = 0; i < 4; i += 1) {
    const shape = new THREE.Shape();
    const width = rand(0.8, 1.35);
    const height = rand(1.2, 2);
    shape.moveTo(0, 0);
    shape.bezierCurveTo(-width, height * 0.22, -width * 0.85, height * 0.88, 0, height);
    shape.bezierCurveTo(width * 0.88, height * 0.82, width, height * 0.2, 0, 0);
    const geo = new THREE.ShapeGeometry(shape, 20);
    const mesh = new THREE.Mesh(geo, material.clone());
    mesh.position.set(rand(-0.3, 0.3), 0, rand(-0.18, 0.18));
    mesh.rotation.set(rand(-0.07, 0.09), rand(-0.45, 0.45), rand(-0.12, 0.12));
    mesh.scale.setScalar(rand(0.78, 1.16));
    group.add(mesh);

    for (let r = 0; r < 7; r += 1) {
      const angle = -0.7 + r * 0.23;
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, 0.06, 0.02),
        new THREE.Vector3(Math.sin(angle) * width * 0.45, height * 0.44, 0.02),
        new THREE.Vector3(Math.sin(angle) * width * 0.78, height * 0.82, 0.02),
      ]);
      const rib = new THREE.Mesh(new THREE.TubeGeometry(curve, 8, 0.012, 5, false), ribMaterial);
      rib.position.copy(mesh.position);
      rib.rotation.copy(mesh.rotation);
      rib.scale.copy(mesh.scale);
      group.add(rib);
    }
  }

  return group;
}

function createBrainCoral(color) {
  const group = new THREE.Group();
  const baseMaterial = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.7,
    metalness: 0.02,
  });
  const base = new THREE.Mesh(new THREE.SphereGeometry(1.1, 38, 20), baseMaterial);
  base.scale.set(1.2, 0.42, 0.88);
  base.castShadow = true;
  group.add(base);

  const ridgeMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color).offsetHSL(0.04, 0.04, 0.16),
    roughness: 0.58,
  });

  for (let i = 0; i < 12; i += 1) {
    const scale = 0.18 + i * 0.075;
    const curvePoints = [];
    for (let j = 0; j <= 42; j += 1) {
      const t = (j / 42) * Math.PI * 2;
      const wobble = 1 + Math.sin(t * 5 + i) * 0.12;
      curvePoints.push(
        new THREE.Vector3(
          Math.cos(t) * scale * wobble * 1.42,
          0.42 + i * 0.014,
          Math.sin(t) * scale * wobble,
        ),
      );
    }
    const curve = new THREE.CatmullRomCurve3(curvePoints, true);
    const ridge = new THREE.Mesh(new THREE.TubeGeometry(curve, 42, 0.025, 5, true), ridgeMaterial);
    group.add(ridge);
  }

  return group;
}

function createAnemone(color) {
  const group = new THREE.Group();
  const baseMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color).offsetHSL(0, -0.05, -0.12),
    roughness: 0.65,
  });
  const tentacleMaterial = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.4,
    emissive: new THREE.Color(color).multiplyScalar(0.12),
  });
  const base = new THREE.Mesh(new THREE.SphereGeometry(0.72, 24, 12), baseMaterial);
  base.scale.set(1, 0.25, 0.8);
  group.add(base);

  const tentacles = [];
  for (let i = 0; i < 38; i += 1) {
    const angle = rand(0, Math.PI * 2);
    const reach = rand(0.36, 1.02);
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(Math.cos(angle) * 0.18, 0.13, Math.sin(angle) * 0.18),
      new THREE.Vector3(Math.cos(angle) * reach * 0.42, rand(0.3, 0.6), Math.sin(angle) * reach * 0.42),
      new THREE.Vector3(Math.cos(angle) * reach, rand(0.48, 0.88), Math.sin(angle) * reach),
    ]);
    const tentacle = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 14, rand(0.025, 0.045), 6, false),
      tentacleMaterial,
    );
    tentacle.userData = { angle, reach, phase: rand(0, Math.PI * 2), home: tentacle.position.clone() };
    tentacles.push(tentacle);
    group.add(tentacle);
  }

  updatables.push((time) => {
    tentacles.forEach((tentacle) => {
      tentacle.rotation.x = Math.sin(time * 0.95 + tentacle.userData.phase) * 0.12;
      tentacle.rotation.z = Math.cos(time * 0.7 + tentacle.userData.phase) * 0.1;
    });
  });

  return group;
}

function createKelpBladeMaterial(color) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    uniforms: {
      time: { value: 0 },
      phase: { value: rand(0, 10) },
      colorA: { value: new THREE.Color(color).offsetHSL(0, 0.08, -0.12) },
      colorB: { value: new THREE.Color(color).offsetHSL(0.03, 0.06, 0.16) },
    },
    vertexShader: `
      uniform float time;
      uniform float phase;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec3 p = position;
        float bend = sin(time * 0.85 + phase + p.y * 1.55) * 0.24;
        p.x += bend * uv.y * uv.y;
        p.z += cos(time * 0.52 + phase + p.y) * 0.08 * uv.y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 colorA;
      uniform vec3 colorB;
      varying vec2 vUv;
      void main() {
        float rib = smoothstep(0.0, 0.08, abs(vUv.x - 0.5));
        vec3 color = mix(colorB, colorA, rib);
        float edge = smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.92, vUv.x);
        float alpha = edge * (0.58 + vUv.y * 0.34);
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });
}

function createKelpForest() {
  const colors = [0x4b9b55, 0x75a642, 0x2f856e, 0x8aa843];
  const positions = [
    [-11, -6.4],
    [-9.5, -6.7],
    [-10.6, -3.2],
    [-8.8, -1.2],
    [10.6, -6.2],
    [11, -3.8],
    [9.4, -1.1],
    [7.6, -5.8],
    [-2.8, -7.6],
    [2.2, -7.1],
  ];

  positions.forEach(([x, z], index) => {
    const blades = Math.floor(rand(5, 10));
    for (let i = 0; i < blades; i += 1) {
      const height = rand(3.2, 7.1);
      const width = rand(0.22, 0.46);
      const geometry = new THREE.PlaneGeometry(width, height, 4, 24);
      geometry.translate(0, height / 2, 0);
      const material = createKelpBladeMaterial(choice(colors));
      const blade = new THREE.Mesh(geometry, material);
      blade.position.set(x + rand(-0.55, 0.55), tank.floor + 0.04, z + rand(-0.5, 0.5));
      blade.rotation.y = rand(0, Math.PI * 2);
      blade.rotation.z = rand(-0.18, 0.18);
      scene.add(blade);
      updatables.push((time) => {
        material.uniforms.time.value = time;
        blade.rotation.z = Math.sin(time * 0.22 + index + i) * 0.08;
      });
    }
  });
}

function createStarfish() {
  const material = new THREE.MeshStandardMaterial({
    color: 0xff8d5b,
    roughness: 0.58,
    emissive: 0x3d1208,
    emissiveIntensity: 0.18,
  });

  [
    [-3.2, tank.floor + 0.12, 5.4, 0.64, 0.5],
    [6.8, tank.floor + 0.13, 3.3, 0.5, -0.6],
  ].forEach(([x, y, z, scale, rot]) => {
    const group = new THREE.Group();
    for (let i = 0; i < 5; i += 1) {
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.65, 5, 10), material);
      arm.position.y = 0.15;
      arm.rotation.z = (i / 5) * Math.PI * 2;
      arm.rotation.x = Math.PI / 2;
      arm.scale.set(1, 1.45, 0.55);
      arm.position.x = Math.cos((i / 5) * Math.PI * 2) * 0.25;
      arm.position.z = Math.sin((i / 5) * Math.PI * 2) * 0.25;
      group.add(arm);
    }
    const center = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 8), material);
    center.scale.y = 0.38;
    group.add(center);
    group.position.set(x, y, z);
    group.rotation.y = rot;
    group.scale.setScalar(scale);
    scene.add(group);
  });
}

function createShells() {
  const shellMaterial = new THREE.MeshStandardMaterial({
    color: 0xf6dbc4,
    roughness: 0.72,
    metalness: 0.02,
  });

  for (let i = 0; i < 28; i += 1) {
    const shell = new THREE.Mesh(new THREE.SphereGeometry(rand(0.08, 0.18), 12, 8), shellMaterial.clone());
    shell.material.color.offsetHSL(rand(-0.04, 0.04), rand(-0.1, 0.1), rand(-0.12, 0.08));
    shell.scale.set(rand(1, 1.8), rand(0.28, 0.56), rand(0.7, 1.1));
    shell.position.set(rand(-11.5, 11.5), tank.floor + rand(0.05, 0.18), rand(-6.8, 7.2));
    shell.rotation.set(rand(0, 0.3), rand(0, Math.PI * 2), rand(-0.3, 0.3));
    shell.castShadow = true;
    shell.receiveShadow = true;
    scene.add(shell);
  }
}

function createFishMaterial(color, emissive = 0x000000) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.34,
    metalness: 0.08,
    emissive,
    emissiveIntensity: 0.06,
  });
}

function createFishGeometry(color, accent, size = 1, species = "reef") {
  const group = new THREE.Group();
  const bodyMaterial = createFishMaterial(color);
  const accentMaterial = createFishMaterial(accent);
  const finMaterial = new THREE.MeshStandardMaterial({
    color: accent,
    roughness: 0.42,
    metalness: 0.02,
    transparent: true,
    opacity: 0.82,
    side: THREE.DoubleSide,
  });
  const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0x071017 });
  const eyeShineMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const hitboxMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    colorWrite: false,
  });

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.62, 28, 18), bodyMaterial);
  body.scale.set(1.35, species === "angelfish" ? 0.82 : 0.62, species === "angelfish" ? 0.52 : 0.46);
  body.castShadow = true;
  group.add(body);

  const stripeCount = species === "clown" ? 3 : species === "tang" ? 1 : 2;
  for (let i = 0; i < stripeCount; i += 1) {
    const stripe = new THREE.Mesh(new THREE.SphereGeometry(0.625, 20, 10), accentMaterial);
    const sx = species === "tang" ? 0.08 : 0.07;
    stripe.scale.set(sx, body.scale.y * 1.02, body.scale.z * 1.03);
    stripe.position.x = -0.42 + i * (species === "clown" ? 0.42 : 0.62);
    group.add(stripe);
  }

  const tailShape = new THREE.Shape();
  tailShape.moveTo(0, 0);
  tailShape.lineTo(-0.82, 0.44);
  tailShape.quadraticCurveTo(-0.58, 0, -0.82, -0.44);
  tailShape.lineTo(0, 0);
  const tail = new THREE.Mesh(new THREE.ShapeGeometry(tailShape), finMaterial);
  tail.position.x = -0.78;
  tail.scale.setScalar(species === "angelfish" ? 1.2 : 0.86);
  tail.userData.tail = true;
  group.add(tail);

  const dorsalShape = new THREE.Shape();
  dorsalShape.moveTo(-0.35, 0);
  dorsalShape.quadraticCurveTo(0.12, 0.6, 0.56, 0);
  dorsalShape.quadraticCurveTo(0.05, 0.18, -0.35, 0);
  const dorsal = new THREE.Mesh(new THREE.ShapeGeometry(dorsalShape), finMaterial);
  dorsal.position.set(0.1, 0.3, 0);
  dorsal.scale.set(0.9, 0.8, 0.8);
  group.add(dorsal);

  const finShape = new THREE.Shape();
  finShape.moveTo(0, 0);
  finShape.quadraticCurveTo(0.38, -0.16, 0.2, -0.58);
  finShape.quadraticCurveTo(-0.16, -0.28, 0, 0);
  const finGeo = new THREE.ShapeGeometry(finShape);
  const leftFin = new THREE.Mesh(finGeo, finMaterial);
  leftFin.position.set(0.16, -0.04, 0.42);
  leftFin.rotation.set(0.25, 0.15, 0.15);
  leftFin.userData.fin = true;
  group.add(leftFin);

  const rightFin = leftFin.clone();
  rightFin.position.z = -0.42;
  rightFin.rotation.z = -0.15;
  rightFin.userData.fin = true;
  group.add(rightFin);

  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), eyeMaterial);
  eyeL.position.set(0.58, 0.14, 0.31);
  group.add(eyeL);

  const eyeR = eyeL.clone();
  eyeR.position.z = -0.31;
  group.add(eyeR);

  const shine = new THREE.Mesh(new THREE.SphereGeometry(0.018, 6, 4), eyeShineMaterial);
  shine.position.set(0.61, 0.158, 0.348);
  group.add(shine);

  const shineR = shine.clone();
  shineR.position.z = -0.348;
  group.add(shineR);

  const hitbox = new THREE.Mesh(new THREE.SphereGeometry(1.12, 8, 6), hitboxMaterial);
  hitbox.name = "fish-click-target";
  hitbox.userData.isClickTarget = true;
  group.add(hitbox);

  group.scale.setScalar(size);
  group.userData.tail = tail;
  group.userData.leftFin = leftFin;
  group.userData.rightFin = rightFin;
  return group;
}

class SwimmingFish {
  constructor({
    name,
    typeId,
    sizeMultiplier,
    color,
    accent,
    size,
    center,
    radiusX,
    radiusZ,
    yAmp,
    speed,
    phase,
    species,
    schoolingOffset = new THREE.Vector3(),
  }) {
    this.name = name;
    this.typeId = typeId;
    this.typeLabel = humanizeId(typeId);
    this.sizeMultiplier = sizeMultiplier;
    this.visualSize = size;
    this.mesh = createFishGeometry(color, accent, size, species);
    this.mesh.name = name;
    this.mesh.userData.fishName = name;
    this.mesh.userData.fishType = typeId;
    this.mesh.userData.swimmingFish = this;
    this.mesh.traverse((child) => {
      child.userData.swimmingFish = this;
      if (child.isMesh) fishHitTargets.push(child);
    });
    this.center = center;
    this.radiusX = radiusX;
    this.radiusZ = radiusZ;
    this.yAmp = yAmp;
    this.speed = speed;
    this.phase = phase;
    this.schoolingOffset = schoolingOffset;
    this.previous = new THREE.Vector3();
    selectableFish.push(this);
    scene.add(this.mesh);
  }

  positionAt(time, target) {
    const t = time * this.speed + this.phase;
    const wobble = Math.sin(t * 1.7) * 0.45;
    target.set(
      this.center.x + Math.cos(t) * this.radiusX + this.schoolingOffset.x + wobble,
      this.center.y + Math.sin(t * 1.42) * this.yAmp + this.schoolingOffset.y,
      this.center.z + Math.sin(t) * this.radiusZ + this.schoolingOffset.z,
    );
  }

  update(time) {
    this.positionAt(time, tmpVec);
    if (this.previous.lengthSq() === 0) this.previous.copy(tmpVec).add(new THREE.Vector3(0.01, 0, 0));

    const direction = tmpVec.clone().sub(this.previous).normalize();
    const yaw = Math.atan2(direction.x, direction.z) - Math.PI / 2;
    const pitch = -direction.y * 0.42;
    this.mesh.position.copy(tmpVec);
    this.mesh.rotation.set(pitch, yaw, Math.sin(time * this.speed * 1.6 + this.phase) * 0.06);
    this.mesh.userData.tail.rotation.y = Math.sin(time * 10 * this.speed + this.phase) * 0.48;
    this.mesh.userData.leftFin.rotation.y = Math.sin(time * 7 * this.speed + this.phase) * 0.24;
    this.mesh.userData.rightFin.rotation.y = -Math.sin(time * 7 * this.speed + this.phase) * 0.24;
    this.previous.copy(tmpVec);
  }
}

function createFishSchools() {
  const fishTypes = aquariumConfig?.fish?.types ?? [];

  fishTypes.forEach((fishType) => {
    const fishEntries = Array.isArray(fishType.fish) ? fishType.fish : [];

    fishEntries.forEach((fishEntry = {}, i) => {
      const phase = Number.isFinite(fishType.phaseStep)
        ? i * fishType.phaseStep + configuredNumber(fishType.phaseJitter, 0)
        : rand(0, Math.PI * 2);
      const sizeMultiplier = configuredNumber(fishEntry.sizeMultiplier, 1);
      const fish = new SwimmingFish({
        name: fishEntry.name ?? `${fishType.id ?? "fish"}_${i + 1}`,
        typeId: fishType.id ?? "configured_fish",
        sizeMultiplier,
        color: fishType.bodyColor ?? "#6be6ff",
        accent: fishType.accentColor ?? "#ffd15c",
        species: fishType.species ?? "reef",
        size: configuredNumber(fishType.size, 0.5) * sizeMultiplier,
        center: configuredVector(fishType.center),
        radiusX: configuredNumber(fishType.radiusX, 7),
        radiusZ: configuredNumber(fishType.radiusZ, 4),
        yAmp: configuredNumber(fishType.yAmp, 0.7),
        speed: configuredNumber(fishType.speed, 0.25),
        phase,
        schoolingOffset: configuredVector(fishType.schoolingOffset),
      });
      updatables.push((time) => fish.update(time));
    });
  });
}

function getMaterialList(material) {
  if (!material) return [];
  return Array.isArray(material) ? material : [material];
}

function setFishMaterialHighlight(fish, isHighlighted) {
  fish.mesh.traverse((child) => {
    getMaterialList(child.material).forEach((material) => {
      if (!material.userData.selectionBase) {
        material.userData.selectionBase = {};
        if (material.emissive) material.userData.selectionBase.emissive = material.emissive.clone();
        if (Number.isFinite(material.emissiveIntensity)) {
          material.userData.selectionBase.emissiveIntensity = material.emissiveIntensity;
        }
      }

      const base = material.userData.selectionBase;
      if (material.emissive) {
        material.emissive.copy(isHighlighted ? new THREE.Color(0xffcf6a) : base.emissive);
      }
      if (Number.isFinite(material.emissiveIntensity)) {
        material.emissiveIntensity = isHighlighted ? Math.max(base.emissiveIntensity ?? 0, 0.52) : base.emissiveIntensity;
      }
      material.needsUpdate = true;
    });
  });
}

function updateFishInspector(fish) {
  selectedFishName.textContent = fish.name;
  selectedFishType.textContent = fish.typeLabel;
  selectedFishSize.textContent = `${fish.sizeMultiplier.toFixed(2)}x`;
  fishInspector.hidden = false;
}

function clearFishSelection() {
  if (selectedFish) setFishMaterialHighlight(selectedFish, false);
  selectedFish = null;
  selectionHalo.visible = false;
  fishInspector.hidden = true;
}

function selectFish(fish) {
  if (!fish) {
    clearFishSelection();
    return;
  }

  if (selectedFish && selectedFish !== fish) setFishMaterialHighlight(selectedFish, false);
  selectedFish = fish;
  setFishMaterialHighlight(fish, true);
  updateFishInspector(fish);
  selectionHalo.visible = true;
  controls.autoRotate = false;
}

function pickFishFromPointer(event) {
  const rect = canvas.getBoundingClientRect();
  clickPointer.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(clickPointer, camera);
  const intersections = raycaster.intersectObjects(fishHitTargets, false);
  const hit = intersections.find((intersection) => intersection.object.userData.swimmingFish);
  selectFish(hit?.object.userData.swimmingFish ?? null);
}

function createRay() {
  const group = new THREE.Group();
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: 0x536b70,
    roughness: 0.48,
    metalness: 0.02,
  });
  const wingMaterial = new THREE.MeshStandardMaterial({
    color: 0x6f8588,
    roughness: 0.52,
    metalness: 0.01,
    side: THREE.DoubleSide,
  });

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.9, 32, 14), bodyMaterial);
  body.scale.set(1.15, 0.22, 0.72);
  group.add(body);

  const wingShape = new THREE.Shape();
  wingShape.moveTo(-0.2, 0);
  wingShape.bezierCurveTo(-1.6, 0.52, -2.7, 0.2, -3.25, -0.22);
  wingShape.bezierCurveTo(-1.6, -0.32, -0.55, -0.18, -0.2, 0);
  const wingGeo = new THREE.ShapeGeometry(wingShape, 24);
  const leftWing = new THREE.Mesh(wingGeo, wingMaterial);
  leftWing.rotation.x = -Math.PI / 2;
  leftWing.position.z = 0.18;
  leftWing.userData.wing = true;
  group.add(leftWing);
  const rightWing = leftWing.clone();
  rightWing.scale.y = -1;
  rightWing.position.z = -0.18;
  rightWing.userData.wing = true;
  group.add(rightWing);

  const tailCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.8, 0, 0),
    new THREE.Vector3(-1.8, 0.05, 0),
    new THREE.Vector3(-3.4, 0.04, 0),
  ]);
  const tail = new THREE.Mesh(new THREE.TubeGeometry(tailCurve, 18, 0.035, 6), bodyMaterial);
  group.add(tail);

  group.scale.setScalar(1.35);
  scene.add(group);

  let previous = new THREE.Vector3();
  updatables.push((time) => {
    const t = time * 0.18;
    const next = new THREE.Vector3(Math.cos(t) * 7.2, 2.1 + Math.sin(t * 1.6) * 0.7, Math.sin(t) * 5.4);
    const direction = next.clone().sub(previous.lengthSq() ? previous : next.clone().addScalar(0.01)).normalize();
    group.position.copy(next);
    group.rotation.y = Math.atan2(direction.x, direction.z) - Math.PI / 2;
    group.rotation.z = Math.sin(time * 0.8) * 0.08;
    leftWing.rotation.z = Math.sin(time * 2.6) * 0.22;
    rightWing.rotation.z = -Math.sin(time * 2.6) * 0.22;
    previous.copy(next);
  });
}

function createJellyfish() {
  const bellMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xd6a4ff,
    emissive: 0x8e52cf,
    emissiveIntensity: 0.22,
    transparent: true,
    opacity: 0.48,
    roughness: 0.18,
    transmission: 0.35,
    thickness: 0.35,
    side: THREE.DoubleSide,
  });
  const tentacleMaterial = new THREE.MeshStandardMaterial({
    color: 0xf3c9ff,
    emissive: 0xaa68e9,
    emissiveIntensity: 0.35,
    transparent: true,
    opacity: 0.58,
  });

  for (let j = 0; j < 5; j += 1) {
    const group = new THREE.Group();
    const bell = new THREE.Mesh(new THREE.SphereGeometry(0.62, 32, 18, 0, Math.PI * 2, 0, Math.PI * 0.72), bellMaterial.clone());
    bell.scale.set(1, 0.72, 1);
    group.add(bell);

    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.025, 8, 38), tentacleMaterial);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.1;
    group.add(ring);

    const tentacles = [];
    for (let i = 0; i < 14; i += 1) {
      const angle = (i / 14) * Math.PI * 2;
      const length = rand(1.2, 2.4);
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(Math.cos(angle) * 0.36, -0.1, Math.sin(angle) * 0.36),
        new THREE.Vector3(Math.cos(angle) * 0.45, -length * 0.42, Math.sin(angle) * 0.45),
        new THREE.Vector3(Math.cos(angle + 0.4) * 0.22, -length, Math.sin(angle + 0.4) * 0.22),
      ]);
      const tentacle = new THREE.Mesh(new THREE.TubeGeometry(curve, 18, 0.014, 5), tentacleMaterial);
      tentacle.userData.phase = rand(0, Math.PI * 2);
      tentacles.push(tentacle);
      group.add(tentacle);
    }

    const base = new THREE.Vector3(rand(-8.5, 8.5), rand(2.2, 6.7), rand(-5.5, 2.5));
    group.position.copy(base);
    group.scale.setScalar(rand(0.72, 1.18));
    scene.add(group);

    updatables.push((time) => {
      const t = time * (0.18 + j * 0.015) + j;
      group.position.set(
        base.x + Math.sin(t * 1.3) * 1.1,
        base.y + Math.sin(t * 1.9) * 0.55,
        base.z + Math.cos(t) * 1.2,
      );
      group.rotation.y = Math.sin(t) * 0.28;
      bell.scale.y = 0.64 + Math.sin(time * 1.7 + j) * 0.08;
      tentacles.forEach((tentacle) => {
        tentacle.rotation.x = Math.sin(time * 1.2 + tentacle.userData.phase) * 0.08;
        tentacle.rotation.z = Math.cos(time * 0.9 + tentacle.userData.phase) * 0.08;
      });
    });
  }
}

function createBubbleColumns() {
  const bubbleMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xdafcff,
    transparent: true,
    opacity: 0.42,
    roughness: 0.02,
    metalness: 0,
    transmission: 0.5,
    thickness: 0.08,
  });
  const bubbleGeo = new THREE.SphereGeometry(1, 12, 8);
  const bubbles = [];
  const columns = [
    [-10.2, -4.2],
    [-6.7, 4.6],
    [8.8, -5.1],
    [4.1, 4.8],
  ];

  columns.forEach(([x, z], c) => {
    for (let i = 0; i < 34; i += 1) {
      const bubble = new THREE.Mesh(bubbleGeo, bubbleMaterial.clone());
      const size = rand(0.045, 0.18);
      const start = rand(tank.floor + 0.2, tank.surface - 0.2);
      bubble.scale.setScalar(size);
      bubble.position.set(x + rand(-0.32, 0.32), start, z + rand(-0.32, 0.32));
      bubble.userData = {
        baseX: x,
        baseZ: z,
        speed: rand(0.5, 1.35),
        phase: rand(0, Math.PI * 2),
        column: c,
      };
      scene.add(bubble);
      bubbles.push(bubble);
    }
  });

  updatables.push((time, delta) => {
    bubbles.forEach((bubble) => {
      bubble.position.y += bubble.userData.speed * delta;
      if (bubble.position.y > tank.surface - 0.1) {
        bubble.position.y = tank.floor + rand(0.1, 0.8);
      }
      const wave = Math.sin(time * 2.1 + bubble.userData.phase + bubble.position.y * 0.35);
      bubble.position.x = bubble.userData.baseX + wave * 0.18 + Math.sin(time * 0.9 + bubble.userData.column) * 0.08;
      bubble.position.z = bubble.userData.baseZ + Math.cos(time * 1.7 + bubble.userData.phase) * 0.18;
    });
  });
}

function createSuspendedParticles() {
  const count = 1600;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const color = new THREE.Color();

  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = rand(-tank.width / 2, tank.width / 2);
    positions[i * 3 + 1] = rand(tank.floor + 0.5, tank.surface - 0.3);
    positions[i * 3 + 2] = rand(-tank.depth / 2, tank.depth / 2);
    color.setHSL(rand(0.48, 0.58), rand(0.35, 0.72), rand(0.52, 0.86));
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: 0.035,
    vertexColors: true,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  scene.add(points);

  updatables.push((time) => {
    points.rotation.y = Math.sin(time * 0.03) * 0.05;
    points.rotation.x = Math.cos(time * 0.025) * 0.025;
  });
}

function createLightShafts() {
  const material = new THREE.MeshBasicMaterial({
    color: 0x9eefff,
    transparent: true,
    opacity: 0.075,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  for (let i = 0; i < 9; i += 1) {
    const geometry = new THREE.PlaneGeometry(rand(1.2, 2.8), tank.height + 2);
    const shaft = new THREE.Mesh(geometry, material.clone());
    shaft.position.set(rand(-11, 11), 1.2, rand(-8.2, 1.5));
    shaft.rotation.set(rand(-0.18, 0.16), rand(-0.55, 0.55), rand(-0.12, 0.12));
    shaft.userData = {
      phase: rand(0, Math.PI * 2),
      baseOpacity: rand(0.04, 0.09),
    };
    scene.add(shaft);
    updatables.push((time) => {
      shaft.material.opacity = shaft.userData.baseOpacity + Math.sin(time * 0.7 + shaft.userData.phase) * 0.018;
      shaft.rotation.y += Math.sin(time * 0.2 + shaft.userData.phase) * 0.0009;
    });
  }
}

function createBackWallDetails() {
  const pipeMaterial = new THREE.MeshStandardMaterial({
    color: 0x132d34,
    roughness: 0.62,
    metalness: 0.28,
  });
  const glowMaterial = new THREE.MeshBasicMaterial({
    color: 0x8cf7ff,
    transparent: true,
    opacity: 0.35,
  });

  for (let i = 0; i < 3; i += 1) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, tank.height - 1.5, 12), pipeMaterial);
    pipe.position.set(-11.2 + i * 2.2, 1.1, -tank.depth / 2 + 0.14);
    pipe.castShadow = true;
    scene.add(pipe);

    const intake = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.028, 8, 20), pipeMaterial);
    intake.position.set(pipe.position.x, tank.floor + 1.2, -tank.depth / 2 + 0.24);
    intake.rotation.x = Math.PI / 2;
    scene.add(intake);
  }

  for (let i = 0; i < 8; i += 1) {
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.09), glowMaterial.clone());
    glow.position.set(-8.6 + i * 2.45, tank.surface - 0.18, -tank.depth / 2 + 0.18);
    scene.add(glow);
    updatables.push((time) => {
      glow.material.opacity = 0.22 + Math.sin(time * 1.2 + i) * 0.08;
    });
  }
}

function setupScene() {
  addLighting();
  createWaterVolume();
  createTank();
  createSandBed();
  createHardscape();
  createBackWallDetails();
  createLightShafts();
  createBubbleColumns();
  createSuspendedParticles();
  createFishSchools();
  createRay();
  createJellyfish();
}

function onResize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
}

function onPointerMove(event) {
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
}

function onPointerDown(event) {
  pointerDownPosition.set(event.clientX, event.clientY);
  hasPointerDown = true;
}

function onPointerUp(event) {
  if (!hasPointerDown) return;
  hasPointerDown = false;
  const dragDistance = pointerDownPosition.distanceTo(new THREE.Vector2(event.clientX, event.clientY));
  if (dragDistance > 6) {
    suppressNextClick = true;
    window.setTimeout(() => {
      suppressNextClick = false;
    }, 0);
    return;
  }
  pickFishFromPointer(event);
}

function onCanvasClick(event) {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  pickFishFromPointer(event);
}

function updateSelectionHalo(time) {
  if (!selectedFish) return;
  selectedFish.mesh.getWorldPosition(selectionHalo.position);
  selectionHalo.quaternion.copy(camera.quaternion);
  selectionHalo.scale.setScalar(Math.max(0.76, selectedFish.visualSize * 2.35));

  const pulse = selectionHalo.userData.pulse;
  pulse.scale.setScalar(1 + Math.sin(time * 4.1) * 0.075);
  pulse.material.opacity = 0.28 + Math.sin(time * 3.4) * 0.08;
}

function animate() {
  const elapsed = clock.getElapsedTime();
  const delta = Math.min(clock.getDelta(), 0.033);

  updatables.forEach((update) => update(elapsed, delta));

  const desiredTarget = new THREE.Vector3(mouse.x * 0.6, 2.2 + mouse.y * 0.25, 0);
  controls.target.lerp(desiredTarget, 0.015);
  controls.update();
  updateSelectionHalo(elapsed);

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

window.addEventListener("resize", onResize);
window.addEventListener("pointermove", onPointerMove);
canvas.addEventListener("pointerdown", onPointerDown);
window.addEventListener("pointerup", onPointerUp);
canvas.addEventListener("click", onCanvasClick);

function installDevDebugTools() {
  if (!import.meta.env.DEV) return;
  window.__aquariumDebug = {
    getFishScreenPositions() {
      return selectableFish.map((fish) => {
        const position = new THREE.Vector3();
        fish.mesh.getWorldPosition(position);
        position.project(camera);
        return {
          name: fish.name,
          type: fish.typeLabel,
          x: (position.x * 0.5 + 0.5) * window.innerWidth,
          y: (-position.y * 0.5 + 0.5) * window.innerHeight,
          z: position.z,
        };
      });
    },
    getSelectedFish() {
      if (!selectedFish) return null;
      return {
        name: selectedFish.name,
        type: selectedFish.typeLabel,
        sizeMultiplier: selectedFish.sizeMultiplier,
      };
    },
    getFishAtScreenPoint(x, y) {
      clickPointer.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
      raycaster.setFromCamera(clickPointer, camera);
      const intersections = raycaster.intersectObjects(fishHitTargets, false);
      const hit = intersections.find((intersection) => intersection.object.userData.swimmingFish);
      if (!hit) return null;
      const fish = hit.object.userData.swimmingFish;
      return {
        name: fish.name,
        type: fish.typeLabel,
        distance: hit.distance,
      };
    },
  };
}

setupScene();
installDevDebugTools();
animate();
