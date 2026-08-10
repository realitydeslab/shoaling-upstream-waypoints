// Static waypoint editor for GitHub Pages. Reads data/journey.json from this
// site, edits points on a metre grid, and publishes by committing the file
// back through the GitHub Contents API. The iPhone app downloads the same
// file over HTTPS on launch.

const OWNER = "realitydeslab";
const REPO = "shoaling-upstream-waypoints";
const SITES_PATH = "data/sites.json";

function apiUrl(path) {
  return `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
}

async function ghGet(path) {
  const response = await fetch(`${apiUrl(path)}?t=${Date.now()}`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`GitHub read failed for ${path}: ${response.status}`);
  }
  const body = await response.json();
  const json = JSON.parse(
    decodeURIComponent(escape(atob(body.content.replace(/\n/g, "")))));
  return { json, sha: body.sha };
}

async function ghPut(path, value, message, sha) {
  const token = tokenInput.value.trim();
  if (!token) {
    throw new Error("a GitHub token (Contents: write) is required");
  }
  const content = btoa(unescape(encodeURIComponent(
    JSON.stringify(value, null, 2) + "\n")));
  const response = await fetch(apiUrl(path), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({ message, content, sha: sha ?? undefined }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.message ?? response.statusText);
  }
  return body.content.sha;
}

const svg = document.getElementById("map");
const statusLine = document.getElementById("status");
const pointList = document.getElementById("point-list");
const pointEditor = document.getElementById("point-editor");
const nameInput = document.getElementById("point-name");
const soundSelect = document.getElementById("point-sound");
const radiusInput = document.getElementById("point-radius");
const radiusValue = document.getElementById("point-radius-value");
const heightInput = document.getElementById("point-height");
const triggerSelect = document.getElementById("point-trigger");
const completionSelect = document.getElementById("point-completion");
const depthInput = document.getElementById("point-depth");
const xInput = document.getElementById("point-x");
const zInput = document.getElementById("point-z");
const tokenInput = document.getElementById("github-token");
const siteSelect = document.getElementById("site-select");

let journey = null;
let journeySha = null;
let sitesIndex = null;
let sitesSha = null;
let currentSiteId = null;
let clips = [];
let selectedId = null;
let dirty = false;
let view = { x: -12, y: -12, size: 24 };
let previewAudio = null;

tokenInput.value = localStorage.getItem("shoaling-github-token") ?? "";
tokenInput.addEventListener("input", () => {
  localStorage.setItem("shoaling-github-token", tokenInput.value);
});

function setStatus(text) {
  statusLine.textContent = text;
}

function selectedEvent() {
  return journey?.events?.find((event) => event.id === selectedId) ?? null;
}

function markDirty() {
  dirty = true;
  setStatus("Unpublished changes");
}

// ---------- spatial preview (Web Audio HRTF ~ Apple PHASE approximation) ----------
// Browser preview only: HRTF panning + distance rolloff approximate the
// PHASE spatializer for authoring; it does not establish AirPods behaviour.

let previewOn = false;
let audioCtx = null;
const previewNodes = new Map();
let listenerPos = { x: 0, z: -6 };

function startPreview() {
  audioCtx ??= new (window.AudioContext ?? window.webkitAudioContext)();
  audioCtx.resume();
  for (const event of journey?.events ?? []) {
    if (!event.audio?.clipId || previewNodes.has(event.id)) continue;
    const element = new Audio(`./audio/${event.audio.clipId}.mp3`);
    element.loop = true;
    element.crossOrigin = "anonymous";
    element.volume = Math.min(1, event.audio.volume ?? 0.5);
    const source = audioCtx.createMediaElementSource(element);
    const panner = audioCtx.createPanner();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = Math.max(0.1, event.audio.minDistanceMeters ?? 0.75);
    panner.maxDistance = Math.max(1, event.audio.maxDistanceMeters ?? 24);
    panner.rolloffFactor = 1;
    source.connect(panner).connect(audioCtx.destination);
    previewNodes.set(event.id, { element, panner });
    element.play().catch(() => setStatus("Click the page once, then re-enable preview."));
  }
  updatePreviewPositions();
}

function stopPreview() {
  for (const node of previewNodes.values()) {
    node.element.pause();
    node.panner.disconnect();
  }
  previewNodes.clear();
}

function updatePreviewPositions() {
  if (!previewOn || !audioCtx) return;
  const now = audioCtx.currentTime;
  const listener = audioCtx.listener;
  if (listener.positionX) {
    listener.positionX.setValueAtTime(listenerPos.x, now);
    listener.positionY.setValueAtTime(1.65, now);
    listener.positionZ.setValueAtTime(listenerPos.z, now);
  } else {
    listener.setPosition(listenerPos.x, 1.65, listenerPos.z);
  }
  for (const event of journey?.events ?? []) {
    const node = previewNodes.get(event.id);
    if (!node) continue;
    const { x, y, z } = event.position;
    if (node.panner.positionX) {
      node.panner.positionX.setValueAtTime(x, now);
      node.panner.positionY.setValueAtTime(y ?? 1.65, now);
      node.panner.positionZ.setValueAtTime(z, now);
    } else {
      node.panner.setPosition(x, y ?? 1.65, z);
    }
  }
}

// ---------- map ----------

function fitViewToPoints() {
  const points = journey?.events ?? [];
  let minX = -5, maxX = 5, minZ = -5, maxZ = 5;
  for (const event of points) {
    minX = Math.min(minX, event.position.x - event.activationRadiusMeters);
    maxX = Math.max(maxX, event.position.x + event.activationRadiusMeters);
    minZ = Math.min(minZ, event.position.z - event.activationRadiusMeters);
    maxZ = Math.max(maxZ, event.position.z + event.activationRadiusMeters);
  }
  const size = Math.max(maxX - minX, maxZ - minZ) + 6;
  view = {
    x: (minX + maxX) / 2 - size / 2,
    y: -((minZ + maxZ) / 2) - size / 2,
    size,
  };
}

function svgPointFromClient(clientX, clientY) {
  const point = new DOMPoint(clientX, clientY);
  return point.matrixTransform(svg.getScreenCTM().inverse());
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function renderMap() {
  svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.size} ${view.size}`);
  const parts = [];
  const start = Math.floor(view.x - 1);
  const end = Math.ceil(view.x + view.size + 1);
  const top = Math.floor(view.y - 1);
  const bottom = Math.ceil(view.y + view.size + 1);
  for (let x = start; x <= end; x++) {
    const cls = x === 0 ? "axis-line" : x % 5 === 0 ? "grid-line major" : "grid-line";
    parts.push(`<line class="${cls}" x1="${x}" y1="${top}" x2="${x}" y2="${bottom}"/>`);
  }
  for (let y = top; y <= bottom; y++) {
    const cls = y === 0 ? "axis-line" : y % 5 === 0 ? "grid-line major" : "grid-line";
    parts.push(`<line class="${cls}" x1="${start}" y1="${y}" x2="${end}" y2="${y}"/>`);
  }
  for (const event of journey?.events ?? []) {
    const x = event.position.x;
    const y = -event.position.z;
    const selected = event.id === selectedId ? " selected" : "";
    parts.push(
      `<circle class="ring${selected}" data-id="${event.id}" cx="${x}" cy="${y}" r="${event.activationRadiusMeters}"/>`,
      `<circle class="dot${selected}" data-id="${event.id}" cx="${x}" cy="${y}" r="0.22"/>`,
      `<text class="point-label" x="${x}" y="${y - event.activationRadiusMeters - 0.35}">${escapeHtml(event.title ?? event.id)}</text>`,
    );
  }
  const selectedEventForGizmo = journey?.events?.find(
    (event) => event.id === selectedId);
  if (selectedEventForGizmo) {
    const gx = selectedEventForGizmo.position.x;
    const gy = -selectedEventForGizmo.position.z;
    const len = Math.max(1.2, view.size * 0.08);
    const head = len * 0.18;
    const grab = len * 0.22;
    parts.push(
      `<line class="gizmo-x" x1="${gx}" y1="${gy}" x2="${gx + len}" y2="${gy}"/>`,
      `<polygon class="gizmo-x-head" points="${gx + len + head},${gy} ${gx + len},${gy - head / 2} ${gx + len},${gy + head / 2}"/>`,
      `<line class="gizmo-grab" data-axis="x" data-id="${selectedEventForGizmo.id}" x1="${gx}" y1="${gy}" x2="${gx + len + head}" y2="${gy}" stroke-width="${grab}"/>`,
      `<line class="gizmo-z" x1="${gx}" y1="${gy}" x2="${gx}" y2="${gy - len}"/>`,
      `<polygon class="gizmo-z-head" points="${gx},${gy - len - head} ${gx - head / 2},${gy - len} ${gx + head / 2},${gy - len}"/>`,
      `<line class="gizmo-grab" data-axis="z" data-id="${selectedEventForGizmo.id}" x1="${gx}" y1="${gy}" x2="${gx}" y2="${gy - len - head}" stroke-width="${grab}"/>`,
    );
  }
  if (previewOn) {
    const lx = listenerPos.x;
    const ly = -listenerPos.z;
    parts.push(
      `<circle class="listener-halo" data-id="__you" cx="${lx}" cy="${ly}" r="0.6"/>`,
      `<circle class="listener-dot" data-id="__you" cx="${lx}" cy="${ly}" r="0.3"/>`,
      `<text class="point-label" x="${lx}" y="${ly - 0.9}">You</text>`,
    );
  }
  svg.innerHTML = parts.join("");
}

let drag = null;
svg.addEventListener("pointerdown", (eventArg) => {
  const id = eventArg.target.dataset?.id;
  const world = svgPointFromClient(eventArg.clientX, eventArg.clientY);
  if (id === "__you") {
    drag = { kind: "listener" };
  } else if (id) {
    const axis = eventArg.target.dataset?.axis;
    if (!axis) selectPoint(id);
    drag = { kind: "point", id, axis };
  } else {
    drag = { kind: "pan", startView: { ...view }, start: world };
  }
  svg.setPointerCapture(eventArg.pointerId);
});
svg.addEventListener("pointermove", (eventArg) => {
  if (!drag) return;
  const world = svgPointFromClient(eventArg.clientX, eventArg.clientY);
  if (drag.kind === "listener") {
    listenerPos = { x: world.x, z: -world.y };
    updatePreviewPositions();
    renderMap();
    return;
  }
  if (drag.kind === "point") {
    const event = journey.events.find((item) => item.id === drag.id);
    if (!event) return;
    if (drag.axis !== "z") event.position.x = Math.round(world.x * 100) / 100;
    if (drag.axis !== "x") event.position.z = Math.round(-world.y * 100) / 100;
    markDirty();
    updatePreviewPositions();
    renderMap();
    renderList();
    renderEditor();
  } else {
    view.x = drag.startView.x - (world.x - drag.start.x);
    view.y = drag.startView.y - (world.y - drag.start.y);
    renderMap();
  }
});
const endDrag = () => { drag = null; };
svg.addEventListener("pointerup", endDrag);
svg.addEventListener("pointercancel", endDrag);

svg.addEventListener("wheel", (eventArg) => {
  eventArg.preventDefault();
  const world = svgPointFromClient(eventArg.clientX, eventArg.clientY);
  const factor = eventArg.deltaY > 0 ? 1.12 : 1 / 1.12;
  const size = Math.min(200, Math.max(4, view.size * factor));
  view = {
    x: world.x - ((world.x - view.x) / view.size) * size,
    y: world.y - ((world.y - view.y) / view.size) * size,
    size,
  };
  renderMap();
}, { passive: false });

// ---------- panel ----------

function renderList() {
  pointList.innerHTML = "";
  for (const event of journey?.events ?? []) {
    const item = document.createElement("li");
    item.className = event.id === selectedId ? "selected" : "";
    const name = document.createElement("span");
    name.textContent = event.title ?? event.id;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent =
      `${event.trigger?.type ?? "proximity"} · ` +
      `${event.position.x.toFixed(1)}, ${event.position.z.toFixed(1)} · ` +
      `${event.activationRadiusMeters.toFixed(1)} m`;
    item.append(name, meta);
    item.addEventListener("click", () => selectPoint(event.id));
    pointList.append(item);
  }
}

function renderEditor() {
  const event = selectedEvent();
  pointEditor.hidden = event === null;
  if (!event) return;
  nameInput.value = event.title ?? "";
  soundSelect.innerHTML = clips
    .map((clip) =>
      `<option value="${clip.clipId}"${clip.clipId === event.audio?.clipId ? " selected" : ""}>` +
      `${escapeHtml(clip.clipId)}</option>`)
    .join("");
  triggerSelect.value = event.trigger?.type ?? "proximity";
  completionSelect.innerHTML = ["<option value=\"\">(none)</option>"]
    .concat(clips.map((clip) =>
      `<option value="${clip.clipId}"${clip.clipId === event.completionAudio?.clipId ? " selected" : ""}>` +
      `${escapeHtml(clip.clipId)}</option>`))
    .join("");
  depthInput.value = event.trigger?.verticalDistanceMeters ?? 0.25;
  radiusInput.value = event.activationRadiusMeters;
  radiusValue.textContent = `${Number(event.activationRadiusMeters).toFixed(1)} m`;
  heightInput.value = event.position.y;
  xInput.value = event.position.x;
  zInput.value = event.position.z;
}

function selectPoint(id) {
  selectedId = id;
  renderList();
  renderEditor();
  renderMap();
}

nameInput.addEventListener("input", () => {
  const event = selectedEvent();
  if (!event) return;
  event.title = nameInput.value;
  markDirty();
  renderList();
  renderMap();
});

soundSelect.addEventListener("change", () => {
  const event = selectedEvent();
  if (!event) return;
  event.audio.clipId = soundSelect.value;
  markDirty();
});

triggerSelect.addEventListener("change", () => {
  const event = selectedEvent();
  if (!event) return;
  event.trigger = { ...(event.trigger ?? {}), type: triggerSelect.value };
  event.trigger.verticalDistanceMeters ??= 0.25;
  event.trigger.minimumUpwardSpeedMetersPerSecond ??= 0.2;
  event.trigger.actionTimeoutSeconds ??= 8;
  event.trigger.actionLabel ??= "";
  // Keep prompts publishable: jump needs its safety condition stated and
  // feeding must clearly apply to a virtual animal only.
  if (triggerSelect.value === "jump" &&
      !/safe|level|dry|clear/i.test(event.prompt ?? "")) {
    event.prompt = "Jump only on the clear, level, dry ground.";
  }
  if (triggerSelect.value === "feed" && !/virtual/i.test(event.prompt ?? "")) {
    event.prompt = "Offer food to the virtual animal. Do not feed real wildlife.";
  }
  markDirty();
  renderList();
});

completionSelect.addEventListener("change", () => {
  const event = selectedEvent();
  if (!event) return;
  if (!completionSelect.value) {
    delete event.completionAudio;
  } else {
    event.completionAudio = {
      ...(event.completionAudio ?? {
        url: "",
        volume: 0.5,
        loop: false,
        minDistanceMeters: 0.75,
        maxDistanceMeters: 24,
        provenance: { assetId: "", sourceUrl: "", creator: "", capturedAt: "", license: "", notes: "" },
      }),
      clipId: completionSelect.value,
      loop: false,
    };
  }
  markDirty();
});

depthInput.addEventListener("input", () => {
  const event = selectedEvent();
  if (!event) return;
  const value = Number(depthInput.value);
  if (Number.isFinite(value) && value > 0) {
    event.trigger = { ...(event.trigger ?? { type: "proximity" }) };
    event.trigger.verticalDistanceMeters = value;
    markDirty();
  }
});

radiusInput.addEventListener("input", () => {
  const event = selectedEvent();
  if (!event) return;
  event.activationRadiusMeters = Number(radiusInput.value);
  radiusValue.textContent = `${event.activationRadiusMeters.toFixed(1)} m`;
  markDirty();
  renderList();
  renderMap();
});

function numericAxisListener(input, axis) {
  input.addEventListener("input", () => {
    const event = selectedEvent();
    if (!event) return;
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;
    event.position[axis] = value;
    markDirty();
    renderMap();
    renderList();
    updatePreviewPositions();
  });
}
numericAxisListener(xInput, "x");
numericAxisListener(zInput, "z");

heightInput.addEventListener("input", () => {
  const event = selectedEvent();
  if (!event) return;
  const value = Number(heightInput.value);
  if (Number.isFinite(value)) {
    event.position.y = value;
    markDirty();
  }
});

document.getElementById("preview-toggle").addEventListener("click", () => {
  previewOn = !previewOn;
  document.getElementById("preview-toggle").classList.toggle("primary", previewOn);
  if (previewOn) {
    startPreview();
    setStatus("Spatial preview on — drag the gold 'You' dot to walk the site.");
  } else {
    stopPreview();
    setStatus("Spatial preview off.");
  }
  renderMap();
});

document.getElementById("listen-point").addEventListener("click", () => {
  const event = selectedEvent();
  if (!event?.audio?.clipId) return;
  if (previewAudio) {
    previewAudio.pause();
    previewAudio = null;
    return;
  }
  previewAudio = new Audio(`./audio/${event.audio.clipId}.mp3`);
  previewAudio.volume = 0.6;
  previewAudio.addEventListener("ended", () => { previewAudio = null; });
  previewAudio.play().catch(() => setStatus("Browser blocked audio; click again."));
});

document.getElementById("add-point").addEventListener("click", () => {
  if (!journey) return;
  const template = selectedEvent() ?? journey.events[0];
  const clone = JSON.parse(JSON.stringify(template));
  const numbers = journey.events
    .map((event) => Number((/^point-(\d+)$/.exec(event.id) ?? [])[1]))
    .filter(Number.isFinite);
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  clone.id = `point-${next}`;
  clone.title = `New point ${next}`;
  clone.kind = "encounter";
  clone.trigger = { ...clone.trigger, type: "proximity" };
  clone.position = {
    x: Math.round((view.x + view.size / 2) * 10) / 10,
    y: template.position.y,
    z: Math.round(-(view.y + view.size / 2) * 10) / 10,
  };
  journey.events.push(clone);
  markDirty();
  selectPoint(clone.id);
});

document.getElementById("delete-point").addEventListener("click", () => {
  const event = selectedEvent();
  if (!event || !journey) return;
  if (journey.events.length <= 1) {
    setStatus("A journey needs at least one waypoint.");
    return;
  }
  journey.events = journey.events.filter((item) => item.id !== event.id);
  selectedId = journey.events[0]?.id ?? null;
  markDirty();
  renderList();
  renderEditor();
  renderMap();
});

function currentSite() {
  return sitesIndex?.sites?.find((site) => site.id === currentSiteId) ?? null;
}

function journeyRepoPath() {
  const site = currentSite();
  return site ? `data/${site.journeyPath}` : null;
}

document.getElementById("publish").addEventListener("click", async () => {
  const path = journeyRepoPath();
  if (!journey || !path) return;
  try {
    setStatus("Publishing…");
    const match = /^r(\d{6})$/.exec(journey.revision ?? "");
    journey.revision = `r${String((match ? Number(match[1]) : 0) + 1).padStart(6, "0")}`;
    journeySha = await ghPut(
      path,
      journey,
      `waypoints(${currentSiteId}): publish ${journey.revision}`,
      journeySha);
    dirty = false;
    const active = sitesIndex?.activeSiteId === currentSiteId
      ? "the iPhone downloads it on next launch"
      : "not the active iPhone site yet — click 'Make active on iPhone'";
    setStatus(`Published ${journey.revision} — ${active}.`);
  } catch (error) {
    setStatus(`Publish failed: ${error.message}`);
  }
});

document.getElementById("make-active").addEventListener("click", async () => {
  if (!sitesIndex || !currentSiteId) return;
  try {
    sitesIndex.activeSiteId = currentSiteId;
    sitesSha = await ghPut(
      SITES_PATH,
      sitesIndex,
      `sites: activate ${currentSiteId}`,
      sitesSha);
    renderSiteSelect();
    setStatus(`'${currentSite()?.name}' is now the site the iPhone app loads.`);
  } catch (error) {
    setStatus(`Could not activate: ${error.message}`);
  }
});

document.getElementById("new-site").addEventListener("click", async () => {
  if (!sitesIndex || !journey) return;
  const name = window.prompt(
    "Site name (from the Scaniverse portal, e.g. 'UBC Trees'):");
  if (!name) return;
  const siteId = window.prompt(
    "Niantic Site ID (UUID from the portal URL):")?.trim();
  if (!siteId) return;
  const payload = window.prompt(
    "Anchor payload (copy it from the Production asset's details):")?.trim();
  if (!payload) return;

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "site";
  if (sitesIndex.sites.some((site) => site.id === slug)) {
    setStatus(`A site named '${slug}' already exists.`);
    return;
  }

  try {
    const fresh = JSON.parse(JSON.stringify(journey));
    const anchorLabel = `production-anchor-${slug}`;
    fresh.revision = "r000001";
    fresh.title = `${name} — waypoints`;
    fresh.summary = `Waypoints for the ${name} site, authored in the online editor.`;
    fresh.site.siteId = siteId;
    fresh.site.originAnchorId = anchorLabel;
    fresh.site.vpsAnchorPayload = payload;
    fresh.site.scanProvenance = {
      assetId: "", sourceUrl: "", creator: "", capturedAt: "", license: "",
      notes: `Registered from the online editor on ${new Date().toISOString().slice(0, 10)}.`,
    };
    for (const event of fresh.events) event.anchorId = anchorLabel;

    await ghPut(
      `data/journeys/${slug}.json`,
      fresh,
      `sites: add ${slug}`);
    sitesIndex.sites.push({
      id: slug, name, journeyPath: `journeys/${slug}.json`,
    });
    sitesSha = await ghPut(
      SITES_PATH, sitesIndex, `sites: register ${slug}`, sitesSha);
    await loadSite(slug);
    setStatus(`Site '${name}' registered — place its waypoints, publish, then make it active.`);
  } catch (error) {
    setStatus(`New site failed: ${error.message}`);
  }
});

siteSelect.addEventListener("change", async () => {
  if (dirty && !window.confirm("Discard unpublished changes on this site?")) {
    siteSelect.value = currentSiteId;
    return;
  }
  await loadSite(siteSelect.value);
});

function renderSiteSelect() {
  if (!sitesIndex) return;
  siteSelect.innerHTML = sitesIndex.sites
    .map((site) =>
      `<option value="${site.id}"${site.id === currentSiteId ? " selected" : ""}>` +
      `${escapeHtml(site.name)}${site.id === sitesIndex.activeSiteId ? " ★" : ""}</option>`)
    .join("");
}

window.addEventListener("beforeunload", (eventArg) => {
  if (dirty) eventArg.preventDefault();
});

// ---------- start ----------

async function loadSite(siteId) {
  const site = sitesIndex.sites.find((item) => item.id === siteId) ??
    sitesIndex.sites[0];
  currentSiteId = site.id;
  stopPreview();
  const loaded = await ghGet(`data/${site.journeyPath}`);
  journey = loaded.json;
  journeySha = loaded.sha;
  dirty = false;
  selectedId = journey.events?.[0]?.id ?? null;
  renderSiteSelect();
  fitViewToPoints();
  renderList();
  renderEditor();
  renderMap();
  if (previewOn) startPreview();
  const active = sitesIndex.activeSiteId === site.id
    ? "active on iPhone"
    : "not active on iPhone";
  setStatus(
    `${site.name}: ${journey.events.length} waypoint(s) · ` +
    `${journey.revision} · ${active}`);
}

async function start() {
  document.getElementById("unity-url").textContent =
    `App site index: https://raw.githubusercontent.com/${OWNER}/${REPO}/main/${SITES_PATH}`;
  try {
    const catalog = await (await fetch("./data/audio.catalog.json")).json();
    clips = catalog.clips ?? [];
    const index = await ghGet(SITES_PATH);
    sitesIndex = index.json;
    sitesSha = index.sha;
    const requested = new URLSearchParams(location.search).get("site");
    await loadSite(requested ?? sitesIndex.activeSiteId);
  } catch (error) {
    setStatus(`Could not load sites: ${error.message}`);
  }
}

start();
