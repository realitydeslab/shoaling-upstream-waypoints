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
  scene.add(gizmo.getHelper());

  scene.add(new THREE.HemisphereLight(0xe8fff0, 0x14251d, 2.2));
  const grid = new THREE.GridHelper(80, 80, 0x2b7053, 0x143b2d);
  grid.material.transparent = true;
  grid.material.opacity = 0.3;
  scene.add(grid);

  markerGroup = new THREE.Group();
  scene.add(markerGroup);

  renderer.domElement.addEventListener("pointerdown", (event) => {
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

  new ResizeObserver(resize).observe(container);
  resize();
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

function animate() {
  if (!animating) return;
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
