// 3D scan view for the online waypoint editor: renders the site's Gaussian
// splat with Spark, shows the waypoints as markers, and moves the selected
// one with the standard three.js TransformControls translate gizmo
// (Unity-style axes). Loaded lazily when the user opens the 3D view.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

let renderer, scene, camera, controls, gizmo, sparkRenderer;
let markerGroup;
let container;
let callbacks = {};
let journeyRef = null;
let selectedIdRef = null;
let markerByEventId = new Map();
let animating = false;
let scanLoaded = "";
let mode = "god";
let gizmoHelper = null;
const userState = {
  pos: null,
  yaw: 0,
  pitch: -0.05,
  keys: new Set(),
  dragging: false,
  prev: { x: 0, y: 0 },
};
const WALK_SPEED = 2.6;

const raycaster = new THREE.Raycaster();
const pointerVec = new THREE.Vector2();

export function init3d(hostElement, hostCallbacks) {
  if (renderer) return;
  container = hostElement;
  callbacks = hostCallbacks;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x081915);

  camera = new THREE.PerspectiveCamera(55, 1, 0.05, 2000);
  camera.position.set(8, 7, 12);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.append(renderer.domElement);

  sparkRenderer = new SparkRenderer({ renderer });
  scene.add(sparkRenderer);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 1.5, 0);

  gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setMode("translate");
  gizmo.setSize(0.9);
  gizmo.addEventListener("dragging-changed", (event) => {
    controls.enabled = !event.value;
  });
  gizmo.addEventListener("objectChange", () => {
    const marker = gizmo.object;
    if (!marker?.userData?.eventId) return;
    callbacks.onMoved?.(marker.userData.eventId, {
      x: Math.round(marker.position.x * 100) / 100,
      y: Math.round(marker.position.y * 100) / 100,
      z: Math.round(marker.position.z * 100) / 100,
    });
  });
  gizmoHelper = gizmo.getHelper();
  scene.add(gizmoHelper);

  scene.add(new THREE.HemisphereLight(0xe8fff0, 0x14251d, 2.2));
  const grid = new THREE.GridHelper(80, 80, 0x2b7053, 0x143b2d);
  grid.material.transparent = true;
  grid.material.opacity = 0.3;
  scene.add(grid);

  markerGroup = new THREE.Group();
  scene.add(markerGroup);

  renderer.domElement.addEventListener("pointerdown", (event) => {
    if (mode === "user") {
      userState.dragging = true;
      userState.prev = { x: event.clientX, y: event.clientY };
      renderer.domElement.setPointerCapture(event.pointerId);
      return;
    }
    if (gizmo.dragging) return;
    const bounds = renderer.domElement.getBoundingClientRect();
    pointerVec.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    pointerVec.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
    raycaster.setFromCamera(pointerVec, camera);
    const hits = raycaster.intersectObjects(markerGroup.children, true);
    const eventId = hits.find((hit) => hit.object.userData?.eventId)
      ?.object.userData.eventId;
    if (eventId) callbacks.onSelected?.(eventId);
  });

  renderer.domElement.addEventListener("pointermove", (event) => {
    if (mode !== "user" || !userState.dragging) return;
    userState.yaw -= (event.clientX - userState.prev.x) * 0.004;
    userState.pitch = Math.max(-1.2, Math.min(1.2,
      userState.pitch - (event.clientY - userState.prev.y) * 0.003));
    userState.prev = { x: event.clientX, y: event.clientY };
  });
  const endLook = () => { userState.dragging = false; };
  renderer.domElement.addEventListener("pointerup", endLook);
  renderer.domElement.addEventListener("pointercancel", endLook);

  window.addEventListener("keydown", (event) => {
    if (animating && mode === "user" &&
        !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName ?? "")) {
      userState.keys.add(event.code);
    }
  });
  window.addEventListener("keyup", (event) => userState.keys.delete(event.code));

  new ResizeObserver(resize).observe(container);
  resize();
}

export function setMode(newMode) {
  if (!renderer) return;
  mode = newMode;
  const god = mode === "god";
  controls.enabled = god;
  gizmo.enabled = god;
  if (gizmoHelper) gizmoHelper.visible = god;
  if (!god) {
    userState.pos ??= new THREE.Vector3(0, 1.65, -8);
    userState.keys.clear();
  }
}

function stepUser(delta) {
  const speed = WALK_SPEED *
    (userState.keys.has("ShiftLeft") || userState.keys.has("ShiftRight") ? 2.2 : 1);
  const forward = new THREE.Vector3(
    -Math.sin(userState.yaw), 0, -Math.cos(userState.yaw));
  const right = new THREE.Vector3(-forward.z, 0, forward.x);
  const move = new THREE.Vector3();
  if (userState.keys.has("KeyW") || userState.keys.has("ArrowUp")) move.add(forward);
  if (userState.keys.has("KeyS") || userState.keys.has("ArrowDown")) move.sub(forward);
  if (userState.keys.has("KeyD") || userState.keys.has("ArrowRight")) move.add(right);
  if (userState.keys.has("KeyA") || userState.keys.has("ArrowLeft")) move.sub(right);
  if (move.lengthSq() > 0) {
    move.normalize().multiplyScalar(speed * delta);
    userState.pos.add(move);
    callbacks.onUserMoved?.(userState.pos.x, userState.pos.z);
  }
  camera.position.copy(userState.pos);
  camera.quaternion.setFromEuler(
    new THREE.Euler(userState.pitch, userState.yaw, 0, "YXZ"));
}

function resize() {
  if (!renderer || !container.clientWidth) return;
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
}

export async function loadScan(url, onStatus) {
  if (!renderer || scanLoaded === url) return;
  for (const child of [...scene.children]) {
    if (child.isSplatMesh) scene.remove(child);
  }
  if (!url) { scanLoaded = ""; return; }
  onStatus?.("Downloading scan…");
  const splat = new SplatMesh({ url, lod: false });
  scene.add(splat);
  await splat.initialized;
  scanLoaded = url;
  onStatus?.("Scan loaded — drag the axis arrows to move the selected point.");
}

export function syncMarkers(journey, selectedId) {
  if (!renderer) return;
  journeyRef = journey;
  selectedIdRef = selectedId;
  for (const child of [...markerGroup.children]) {
    markerGroup.remove(child);
    child.traverse?.((node) => {
      node.geometry?.dispose?.();
      node.material?.dispose?.();
    });
  }
  markerByEventId = new Map();

  for (const event of journey?.events ?? []) {
    const selected = event.id === selectedId;
    const marker = new THREE.Group();
    marker.position.set(event.position.x, event.position.y, event.position.z);
    marker.userData.eventId = event.id;

    const core = new THREE.Mesh(
      new THREE.SphereGeometry(selected ? 0.24 : 0.17, 20, 14),
      new THREE.MeshStandardMaterial({
        color: selected ? 0xffffff : 0x9fd9c4,
        emissive: selected ? 0x7fe0a8 : 0x2f8f6f,
        emissiveIntensity: selected ? 1.2 : 0.6,
      }),
    );
    core.userData.eventId = event.id;

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(
        Math.max(0.1, event.activationRadiusMeters - 0.06),
        event.activationRadiusMeters,
        64,
      ),
      new THREE.MeshBasicMaterial({
        color: selected ? 0x9fe8c6 : 0x3f8f6f,
        transparent: true,
        opacity: selected ? 0.4 : 0.18,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -event.position.y + 0.03;
    ring.userData.eventId = event.id;

    marker.add(core, ring);
    markerGroup.add(marker);
    markerByEventId.set(event.id, marker);
  }

  const selectedMarker = markerByEventId.get(selectedId);
  if (selectedMarker) gizmo.attach(selectedMarker);
  else gizmo.detach();
}

export function setVisible(visible) {
  if (!renderer) return;
  animating = visible;
  if (visible) animate();
}

let lastTime = 0;
function animate(time = 0) {
  if (!animating) return;
  requestAnimationFrame(animate);
  const delta = Math.min(0.05, (time - lastTime) / 1000 || 0.016);
  lastTime = time;
  if (mode === "god") controls.update();
  else stepUser(delta);
  renderer.render(scene, camera);
}
