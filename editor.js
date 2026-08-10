// Static waypoint editor for GitHub Pages. Reads data/journey.json from this
// site, edits points on a metre grid, and publishes by committing the file
// back through the GitHub Contents API. The iPhone app downloads the same
// file over HTTPS on launch.

const OWNER = "realitydeslab";
const REPO = "shoaling-upstream-waypoints";
const JOURNEY_PATH = "data/journey.json";
const API_URL =
  `https://api.github.com/repos/${OWNER}/${REPO}/contents/${JOURNEY_PATH}`;

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
const tokenInput = document.getElementById("github-token");

let journey = null;
let journeySha = null;
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
  svg.innerHTML = parts.join("");
}

let drag = null;
svg.addEventListener("pointerdown", (eventArg) => {
  const id = eventArg.target.dataset?.id;
  const world = svgPointFromClient(eventArg.clientX, eventArg.clientY);
  if (id) {
    selectPoint(id);
    drag = { kind: "point", id };
  } else {
    drag = { kind: "pan", startView: { ...view }, start: world };
  }
  svg.setPointerCapture(eventArg.pointerId);
});
svg.addEventListener("pointermove", (eventArg) => {
  if (!drag) return;
  const world = svgPointFromClient(eventArg.clientX, eventArg.clientY);
  if (drag.kind === "point") {
    const event = journey.events.find((item) => item.id === drag.id);
    if (!event) return;
    event.position.x = Math.round(world.x * 100) / 100;
    event.position.z = Math.round(-world.y * 100) / 100;
    markDirty();
    renderMap();
    renderList();
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
  radiusInput.value = event.activationRadiusMeters;
  radiusValue.textContent = `${Number(event.activationRadiusMeters).toFixed(1)} m`;
  heightInput.value = event.position.y;
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
    event.completionAudio = null;
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

radiusInput.addEventListener("input", () => {
  const event = selectedEvent();
  if (!event) return;
  event.activationRadiusMeters = Number(radiusInput.value);
  radiusValue.textContent = `${event.activationRadiusMeters.toFixed(1)} m`;
  markDirty();
  renderList();
  renderMap();
});

heightInput.addEventListener("input", () => {
  const event = selectedEvent();
  if (!event) return;
  const value = Number(heightInput.value);
  if (Number.isFinite(value)) {
    event.position.y = value;
    markDirty();
  }
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

document.getElementById("publish").addEventListener("click", async () => {
  if (!journey) return;
  const token = tokenInput.value.trim();
  if (!token) {
    setStatus("Publishing needs a GitHub token (Contents: write on this repo).");
    return;
  }
  try {
    setStatus("Publishing…");
    const match = /^r(\d{6})$/.exec(journey.revision ?? "");
    journey.revision = `r${String((match ? Number(match[1]) : 0) + 1).padStart(6, "0")}`;
    const content = btoa(unescape(encodeURIComponent(
      JSON.stringify(journey, null, 2) + "\n")));
    const response = await fetch(API_URL, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({
        message: `waypoints: publish ${journey.revision}`,
        content,
        sha: journeySha ?? undefined,
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.message ?? response.statusText);
    }
    journeySha = body.content.sha;
    dirty = false;
    setStatus(`Published ${journey.revision} — the iPhone downloads it on next launch.`);
  } catch (error) {
    setStatus(`Publish failed: ${error.message}`);
  }
});

window.addEventListener("beforeunload", (eventArg) => {
  if (dirty) eventArg.preventDefault();
});

// ---------- start ----------

async function start() {
  document.getElementById("unity-url").textContent =
    `Unity download URL: https://raw.githubusercontent.com/${OWNER}/${REPO}/main/${JOURNEY_PATH}`;
  try {
    // The Contents API gives both fresh content and the sha needed to commit.
    const response = await fetch(`${API_URL}?t=${Date.now()}`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (response.ok) {
      const body = await response.json();
      journeySha = body.sha;
      journey = JSON.parse(
        decodeURIComponent(escape(atob(body.content.replace(/\n/g, "")))));
    } else {
      journey = await (await fetch(`./${JOURNEY_PATH}?t=${Date.now()}`)).json();
    }
    const catalog = await (await fetch("./data/audio.catalog.json")).json();
    clips = catalog.clips ?? [];
    selectedId = journey.events?.[0]?.id ?? null;
    fitViewToPoints();
    renderList();
    renderEditor();
    renderMap();
    setStatus(`Loaded ${journey.events.length} waypoint(s) · ${journey.revision}`);
  } catch (error) {
    setStatus(`Could not load journey: ${error.message}`);
  }
}

start();
