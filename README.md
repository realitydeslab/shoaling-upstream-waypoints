# Shoaling Upstream — online waypoint editor

Public waypoint authoring for the Shoaling Upstream AR journey (Strawberry Creek South,
Berkeley). Mark trees as points of interest; the iPhone app downloads this data on launch and
plays each point's music through Apple PHASE when a participant walks close.

- **Editor:** https://realitydeslab.github.io/shoaling-upstream-waypoints/
- **Journey JSON the app downloads:**
  `https://raw.githubusercontent.com/realitydeslab/shoaling-upstream-waypoints/main/data/journey.json`

## Publishing edits

Editing in the browser commits `data/journey.json` back to this repository through the GitHub
Contents API. Paste a fine-grained personal access token (this repository only, permission
**Contents: Read and write**) into the token field once; it stays in your browser's localStorage.

## Provenance

Journey schema 1.1 from the private research repository (`realitydeslab/shoaling-upstream`,
`06-system/schema`). Audio and scan provenance are recorded inside `data/journey.json`. The VPS2
anchor payload is intentionally public so the app can localize before any operator control is
enabled.
