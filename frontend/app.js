const app = document.getElementById("app");
const state = {
  examples: [], // built-in photos
  examplesError: null, // why examples failed
  claude: false, // Claude check allowed
  example: null, // chosen example
  name: "", // file name of the photo
  attack: null, // attack result
  options: null, // protect checkboxes
  protect: null, // protect result
  view: { heat: true, text: true }, // photo layers shown
  feed: [], // uploaded profile photos
  feedName: "", // which feed was attacked
  posts: [], // photos in the profile result
  profile: null, // profile result
  screen: null, // template on screen
};
let timer = null;
let geo = null;

// small helpers
function esc(text) { return String(text).replace(/[&<>"']/g, (char) => "&#" + char.charCodeAt(0) + ";"); }

// format a distance in km
function km(value) {
  if (value < 10) return value.toFixed(1).replace(/\.0$/, "");
  return Math.round(value).toLocaleString("en-US");
}

// add an s when count isn't 1
function plural(count, word) { return count + " " + word + (count === 1 ? "" : "s"); }
// middle value of a list
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// clue without the looks-like prefix
function clueText(clue) { return clue.clue.replace(/^looks like (a |an )?/i, ""); }
// first letter in capitals
function capital(text) { return text.charAt(0).toUpperCase() + text.slice(1); }
// is this an iPhone HEIC file
function isHeic(name) { return /\.(heic|heif)$/i.test(name); }
// is this file an image
function isImage(file) { return /^image\//.test(file.type) || isHeic(file.name); }
// url of an uploaded photo
function photoUrl(id) { return "photo/" + encodeURIComponent(id) + ".jpg"; }
// url of an example photo
function exampleUrl(id) { return "example_image/" + encodeURIComponent(id) + ".jpg"; }
// put html into an element
function fill(id, html) { document.getElementById(id).innerHTML = html; }
// set the screen reader text
function say(text) { document.getElementById("say").textContent = text; }
// km between two points
function distanceKm(a, b) { return d3.geoDistance([a.lon, a.lat], [b.lon, b.lat]) * 6371; }
// km number with a small unit
function kmNum(value, prefix = "") { return `${prefix}${km(value)}<span class="u">km</span>`; }
// examples for the profile feed
function feedExamples() { return state.examples.filter((example) => example.mode === "profile"); }
// lat and lon on two lines
function coords(point) {
  return `${Math.abs(point.lat).toFixed(2)}° ${point.lat < 0 ? "S" : "N"}<br>${Math.abs(point.lon).toFixed(2)}° ${point.lon < 0 ? "W" : "E"}`;
}

// server calls
async function getJson(path, options) {
  const offline = new Error("Can't reach the Unmapped server. Start it on this laptop, then reload the page.");
  const response = await fetch(path, options).catch(() => { throw offline; });
  const body = await response.json().catch(() => ({}));
  if (response.ok) return body;
  throw new Error(typeof body.detail === "string" ? body.detail : "The server returned error " + response.status + ".");
}

// send a form to the server
function postForm(path, fields) {
  const form = new FormData();
  Object.entries(fields).forEach(([key, value]) => form.append(key, value));
  return getJson(path, { method: "POST", body: form });
}

// switch light or dark
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.getElementById("theme").setAttribute("aria-label", "Switch to " + (theme === "dark" ? "light" : "dark") + " theme");
  try { localStorage.setItem("theme", theme); } catch (error) {}
}

// scale the 1920x1080 layout to any projector
function fitStage() {
  const zoom = innerWidth >= 1000 ? Math.min(innerWidth / 1920, innerHeight / 1080) : 1;
  document.body.style.zoom = zoom;
  // laptops get bigger small labels
  document.documentElement.classList.toggle("small", zoom < 0.8);
  document.documentElement.style.setProperty("--stage-w", innerWidth / zoom + "px");
  document.documentElement.style.setProperty("--stage-h", innerHeight / zoom + "px");
}

// line icons, 20 px
const ICONS = {
  text: '<path d="M4 5h12M10 5v11"/>',
  scene: '<path d="M2.5 16.5h15M4 16.5V9l6-4 6 4v7.5"/><path d="M8 16.5v-4a2 2 0 0 1 4 0v4"/>',
  pin: '<path d="M10 17.5s5.5-5 5.5-9.5a5.5 5.5 0 0 0-11 0c0 4.5 5.5 9.5 5.5 9.5Z"/><circle cx="10" cy="8" r="1.8"/>',
  face: '<circle cx="10" cy="10" r="7.2"/><path d="M7.3 12.2c.8.8 1.7 1.2 2.7 1.2s1.9-.4 2.7-1.2M7.6 8.2h.01M12.4 8.2h.01"/>',
  camera: '<path d="M2.5 6.5h3l1.5-2h6l1.5 2h3v10h-15z"/><circle cx="10" cy="11" r="3"/>',
  globe: '<circle cx="10" cy="10" r="7.2"/><path d="M2.8 10h14.4M10 2.8c2 2 2.8 4.4 2.8 7.2s-.8 5.2-2.8 7.2c-2-2-2.8-4.4-2.8-7.2s.8-5.2 2.8-7.2Z"/>',
  unread: '<path d="M4 5h12M10 5v11M3 17 17 3"/>',
  cloak: '<rect x="3" y="3" width="14" height="14" rx="2.5"/><path d="M3 8h14M3 12.5h14M8 3v14M12.5 3v14" stroke-opacity=".6"/>',
  file: '<path d="M5 2.5h7l3.5 3.5v11.5H5z"/><path d="m7.5 11 2 2 3.5-4"/>',
  again: '<path d="M16.5 10a6.5 6.5 0 1 1-2-4.7"/><path d="M16.5 3v3.5H13"/>',
  alert: '<path d="M10 3 2.5 16.5h15z"/><path d="M10 8.5v3.5M10 14.5h.01"/>',
  check: '<path d="m4 10.5 4 4 8-9"/>',
  shield: '<path d="M10 2.5 3.5 5v5c0 3.9 2.8 6.6 6.5 7.5 3.7-.9 6.5-3.6 6.5-7.5V5L10 2.5Z"/>',
  download: '<path d="M10 3v10M5.5 8.5 10 13l4.5-4.5M3.5 16.5h13"/>',
  upload: '<path d="M10 14V3M5.5 7.5 10 3l4.5 4.5M3.5 16.5h13"/>',
  dot: '<circle cx="10" cy="10" r="2.5"/>',
};

// one icon as svg
function icon(name) { return `<svg class="i" viewBox="0 0 20 20" aria-hidden="true">${ICONS[name]}</svg>`; }

// rounded status label
function chip(kind, text, dot = false) { return `<span class="chip ${kind}">${dot ? "<i></i>" : ""}${text}</span>`; }

// fill the page header
function head(title, chipHtml, meta, actionHtml = "") {
  fill("title", `<span class="title-text">${esc(title)}</span>${chipHtml}`);
  fill("meta", meta.filter(Boolean).map((part) => `<span>${part}</span>`).join('<span class="sep"></span>'));
  fill("action", actionHtml);
}

// set the breadcrumb
function crumbs(section, leaf) {
  fill("crumb-section", esc(section));
  fill("crumb-leaf", esc(leaf));
}

// swap in a screen
function show(templateId, tab) {
  clearInterval(timer);
  state.screen = templateId;
  ["attack", "protect", "profile"].forEach((name) => {
    const button = document.getElementById("tab-" + name);
    button.classList.toggle("on", name === tab);
    if (name === tab) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
  });
  document.getElementById("tab-protect").disabled = !(state.protect && state.attack && state.protect.id === state.attack.id);
  fill("map-credit", "");
  fill("photo-credit", "");
  app.replaceChildren(document.getElementById(templateId).content.cloneNode(true));
  app.querySelectorAll("[data-icon]").forEach((box) => (box.innerHTML = icon(box.dataset.icon)));
  document.getElementById("title").focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

// open the file picker
function pickFiles(inputId, onFiles) {
  const input = document.getElementById(inputId);
  input.onchange = () => {
    if (input.files.length) onFiles([...input.files]);
    input.value = "";
  };
  input.click();
}

// drag files onto a zone
function hookDrop(zone, onFiles) {
  zone.addEventListener("dragover", (event) => { event.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("over");
    onFiles([...event.dataTransfer.files]);
  });
}

// pick one photo to attack
function openPhoto() { pickFiles("pick-one", (files) => runUpload(files[0])); }

// screen: start
function renderStart() {
  show("tpl-start", "attack");
  crumbs("Scans", "New scan");
  head("See what a photo gives away", "", ["Three attacks, all on this laptop", "Then Unmapped hides what they found and attacks again"],
    `<button type="button" class="btn primary" id="choose">${icon("upload")}Choose a photo</button>`);
  document.getElementById("choose").addEventListener("click", openPhoto);
  document.getElementById("drop").addEventListener("click", openPhoto);
  hookDrop(document.getElementById("drop-zone"), (files) => runUpload(files[0]));
  showExamples();
}

// list the example photos
function showExamples() {
  const box = document.getElementById("examples");
  if (!box || state.screen !== "tpl-start") return;
  const singles = state.examples.filter((example) => example.mode !== "profile");
  if (state.examplesError) box.innerHTML = `<p class="pad notice" role="alert">${esc(state.examplesError)}</p>`;
  if (!singles.length) return;
  box.innerHTML = `<ul class="examples">${singles.map((example) => `<li>
    <button type="button" class="example" data-example="${esc(example.id)}">
      <img src="${exampleUrl(example.id)}" alt="" loading="lazy"><span>${esc(example.title)}</span>
    </button></li>`).join("")}</ul>`;
  box.querySelectorAll("[data-example]").forEach((button) => button.addEventListener("click", () => runExample(button.dataset.example)));
}

// screen: waiting
function renderWait(title, detail, left, plan, tab) {
  show("tpl-wait", tab);
  crumbs(tab === "profile" ? "Profiles" : "Scans", tab === "profile" ? state.feedName : state.name);
  head(tab === "profile" ? state.feedName : state.name, chip("mute busy", tab === "protect" ? "Protecting" : "Attacking", true), [plural(plan.length, "step"), "Runs on this laptop"]);
  fill("wait-title", esc(title));
  fill("wait-detail", esc(detail));
  fill("wait-left", left);
  fill("plan", plan.map((item) => `<li class="row">${`<span class="ico">${icon("dot")}</span>`}<div><p class="rt">${esc(item)}</p></div></li>`).join(""));
  say(title);
  const start = Date.now();
  timer = setInterval(() => fill("elapsed", Math.floor((Date.now() - start) / 1000) + "<small>s</small>"), 250);
}

// photo with a scan line
function preview(src, alt) { return `<div class="preview"><img src="${src}" alt="${esc(alt)}"><span class="scan" aria-hidden="true"></span></div>`; }

// draw the error screen
function renderError(message) {
  show("tpl-error", null);
  head("Something went wrong", chip("hot", "Stopped", true), ["Nothing was saved or sent"]);
  fill("error-text", esc(message));
  document.getElementById("back").addEventListener("click", renderStart);
}

// send the photo and show results
function runAttack(request, left) {
  const plan = ["Read the file's metadata", "GeoCLIP guesses the location from pixels", "Find readable text and faces", "Map what gave it away"];
  renderWait("Attacking this photo", "An open AI model and two detectors scan the pixels. This takes a few seconds.", left, plan, "attack");
  return request.then((result) => { state.attack = result; state.protect = null; renderAttack(); }).catch((error) => renderError(error.message));
}

// attack an example photo
function runExample(id) {
  state.example = state.examples.find((example) => example.id === id) || null;
  state.name = id + ".jpg";
  const title = state.example ? state.example.title : "Example photo";
  return runAttack(postForm("attack_example/" + encodeURIComponent(id), {}), preview(exampleUrl(id), title));
}

// attack an uploaded photo
function runUpload(file) {
  state.example = null;
  if (!file || !isImage(file)) return renderError("That file isn't a photo. Choose a JPEG, PNG or HEIC image.");
  state.name = file.name;
  const left = isHeic(file.name) ? "" : preview(URL.createObjectURL(file), "Your photo");
  return runAttack(postForm("attack", { image: file }), left);
}

// text and face boxes
function clueList(attack) {
  return [
    ...attack.text.map((item) => ({ box: item.box, label: item.text.replace(/^\W+/, ""), kind: "text" })),
    ...attack.faces.map((item) => ({ box: item.box, label: "Face", kind: "face" })),
  ];
}

// skip OCR junk with under 3 letters
function readable(clue) { return clue.kind === "face" || letters(clue) >= 3; }

// count of letters in a clue
function letters(clue) { return (clue.label.match(/[a-z]/gi) || []).length; }

// boxes as % of the photo
function boxStyle(box, attack) {
  const [left, top, right, bottom] = box;
  return `left:${(left / attack.width) * 100}%;top:${(top / attack.height) * 100}%;width:${((right - left) / attack.width) * 100}%;height:${((bottom - top) / attack.height) * 100}%`;
}

// do two boxes overlap
function overlaps(a, b) { return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]; }

// white labels under the first 3 boxes
function boxLabels(items, attack, iconName) {
  const shot = document.getElementById("shot");
  const [w, h] = [shot.clientWidth, shot.clientHeight];
  const placed = [];
  return items.slice(0, 3).map((item) => {
    const [left, top, right, bottom] = [item.box[0] * w / attack.width, item.box[1] * h / attack.height, item.box[2] * w / attack.width, item.box[3] * h / attack.height];
    const width = item.text.length * 11 + 48;
    const x = Math.min(Math.max(left, 8), w - width - 8);
    let y = bottom + 48 < h ? bottom + 8 : Math.max(top - 46, 8);
    // step down past other labels
    while (placed.some((other) => overlaps(other, [x, y, x + width, y + 38])) && y < h - 46) y += 44;
    placed.push([x, y, x + width, y + 38]);
    return `<span class="label" style="left:${(x / w) * 100}%;top:${(y / h) * 100}%">${icon(iconName)}<span>${esc(item.text)}</span></span>`;
  }).join("");
}

// boxes and labels for text and faces
function clueMarks(attack) {
  const clues = clueList(attack);
  const named = clues.filter(readable).map((clue) => ({ box: clue.box, text: clue.label.slice(0, 30) }));
  return clues.map((clue) => `<div class="mark ${clue.kind}" style="${boxStyle(clue.box, attack)}"></div>`).join("") + boxLabels(named, attack, "text");
}

// paint the heat grid, the browser smooths it
function paintHeat(heat) {
  const canvas = document.getElementById("heat-canvas");
  canvas.width = canvas.height = heat.length;
  const pen = canvas.getContext("2d");
  const peak = Math.max(...heat.flat(), 0.01);
  heat.forEach((row, y) => row.forEach((value, x) => {
    pen.fillStyle = `rgba(226, 71, 12, ${Math.min(1, Math.max(0, value / peak - 0.06) * 1.15)})`;
    pen.fillRect(x, y, 1, 1);
  }));
}

// show or hide the photo layers
function setView(view) {
  state.view = view;
  if (state.screen !== "tpl-attack") return;
  document.getElementById("heat-layer").hidden = !view.heat;
  document.getElementById("legend").hidden = !view.heat;
  document.getElementById("marks").hidden = !view.text;
  document.getElementById("mode-heat").setAttribute("aria-pressed", view.heat);
  document.getElementById("mode-text").setAttribute("aria-pressed", view.text);
  document.getElementById("mode-original").setAttribute("aria-pressed", !view.heat && !view.text);
}

// handle a photo mode button or key
function photoMode(mode) {
  const view = state.view;
  if (mode === "heat") setView({ ...view, heat: !view.heat });
  if (mode === "text") setView({ ...view, text: !view.text });
  // original again brings both back
  if (mode === "original") setView(view.heat || view.text ? { heat: false, text: false } : { heat: true, text: true });
}

// alt text for the photo
function photoAlt() { return state.example ? "Example photo: " + state.example.title : "Your uploaded photo"; }

// one row of a findings list
function row(iconName, kind, title, detail, chipHtml, extra = "") {
  return `<li class="row ${extra}"><span class="ico ${kind}">${icon(iconName)}</span><div><p class="rt">${title}</p><p class="rd">${detail}</p></div>${chipHtml}</li>`;
}

// the five checks on an attacked photo
function findingRows(attack) {
  const meta = attack.metadata;
  const rows = [];
  if (meta.gps) rows.push(row("pin", "hot", "GPS location in the file", `<span class="mono">${coords(meta.gps).replace("<br>", ", ")}</span>&nbsp; <span id="gps-place"></span>`, chip("hot", "High"), "lead"));
  const texts = clueList(attack).filter((clue) => clue.kind === "text" && readable(clue));
  if (texts.length) rows.push(row("text", "hot", "Readable text", `<q>${esc(texts[0].label.slice(0, 30))}</q>${texts.length > 1 ? ` +${texts.length - 1} more` : ""}`, texts.some((clue) => letters(clue) >= 4) ? chip("hot", "High") : chip("hot", "Medium")));
  else rows.push(row("text", "ok", "Readable text", "No signs or words found", chip("ok", "Clean")));
  const scenes = attack.ambient.map(clueText);
  if (scenes.length) rows.push(row("scene", "hot", esc(capital(scenes[0])), scenes[1] ? "Also " + esc(scenes[1]) : "Scenery the model can match", chip("hot", "Medium")));
  else rows.push(row("scene", "", "Scenery", "No standout landmark found", chip("mute", "Low")));
  const faces = attack.faces.length;
  rows.push(faces ? row("face", "hot", plural(faces, "face"), "People who can be recognized", chip("hot", "High")) : row("face", "ok", "Faces", "None detected", chip("ok", "Clean")));
  if (!meta.gps) rows.push(row("pin", "ok", "GPS metadata", "No coordinates stored in the file", chip("ok", "Clean")));
  const stamp = [meta.camera, meta.taken && "taken " + meta.taken.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3").slice(0, 10)].filter(Boolean).join(", ");
  rows.push(stamp ? row("camera", "hot", "Camera and time", esc(stamp), chip("hot", "Medium")) : row("camera", "ok", "Camera and time", "No device model or timestamp", chip("ok", "Clean")));
  return rows;
}

// one stat under a map
function stat(label, value, sub = "", cls = "") {
  return `<div class="stat"><p class="sl">${label}</p><p class="sv ${cls}">${value}</p>${sub ? `<p class="sub">${sub}</p>` : ""}</div>`;
}

// privacy score with a 20 step meter
function scoreHtml(score, was = null) {
  const base = was == null ? score : Math.min(score, was);
  const segs = d3.range(20).map((i) => `<i class="${(i + 1) * 5 <= base ? "on" : (i + 1) * 5 <= score ? "gain" : ""}"></i>`).join("");
  const delta = was == null || score === was ? "" : `<em class="${score > was ? "up" : "down"}">${score > was ? "+" : ""}${score - was}</em>`;
  return `<p class="score-label">Privacy score</p><p class="big"><b>${score}</b><span>/ 100</span>${delta}</p>
    <div class="meter"><div class="segs">${segs}</div><div class="scale"><span>${was == null ? "0 exposed" : "Was " + was}</span><span>100 safest</span></div></div>`;
}

const ZONES = [[0.1, 1, "Street", "street level"], [1, 10, "Neighborhood", "same neighborhood"], [10, 100, "City", "same city"], [100, 1000, "Region", "same region"], [1000, 20037, "Another continent", "far away"]];

// which zone a distance falls in
function zoneOf(value) { return ZONES.find((zone) => value < zone[1]) || ZONES[4]; }

// log band of how far off the guess is
function drawRuler(marks) {
  const svg = document.getElementById("ruler");
  const width = svg.clientWidth;
  const axis = 100;
  const x = d3.scaleLog().domain([0.1, 20037]).range([0, width]).clamp(true);
  svg.setAttribute("viewBox", `0 0 ${width} 172`);
  let html = `<rect class="band" y="${axis}" width="${width}" height="38" rx="6"/>`;
  let zones = "";
  ZONES.forEach(([from, to, name], index) => {
    if (index) html += `<line class="zone-line" x1="${x(from)}" x2="${x(from)}" y1="${axis}" y2="${axis + 38}"/>`;
    zones += `<text class="zone" x="${(x(from) + x(to)) / 2}" y="${axis + 26}" text-anchor="middle">${name}</text>`;
  });
  html += `<line class="axis" x1="0" x2="${width}" y1="${axis}" y2="${axis}"/><line class="axis" x1="${width}" x2="${width}" y1="${axis - 30}" y2="${axis + 38}"/>`;
  // ticks at 1 to 9 of each power of ten
  d3.range(-1, 5).forEach((power) => d3.range(1, 10).forEach((step) => {
    const at = x(step * 10 ** power);
    if (step * 10 ** power <= 20037) html += `<line class="tick${step === 1 ? " major" : ""}" x1="${at}" x2="${at}" y1="${axis}" y2="${axis - (step === 1 ? 12 : 5)}"/>`;
  }));
  [0.1, 1, 10, 100, 1000, 10000].forEach((value) => {
    html += `<text class="dec" x="${x(value)}" y="${axis - 18}" text-anchor="${value === 0.1 ? "start" : value === 10000 ? "end" : "middle"}">${value.toLocaleString("en-US")}</text>`;
  });
  html += `<text class="far" x="${width}" y="${axis + 64}" text-anchor="end">20,037 km is the far side of Earth</text>`;
  const spots = marks.map((mark) => x(Math.max(mark.km, 0.1)));
  // hop arrow from the first mark to the second
  if (marks.length === 2 && Math.abs(spots[1] - spots[0]) > 60) {
    const [a, b] = spots;
    const dir = b > a ? 1 : -1;
    html += `<path class="hop" d="M${a + 6 * dir} 66 C ${a + 140 * dir} 50, ${b - 160 * dir} 50, ${b - 10 * dir} 66"/><path class="hop" d="M${b - 18 * dir} 60l8 6-9 3"/>`;
    if (Math.abs(b - a) > 420 && marks[1].hop) html += `<text class="hop-label" x="${(a + b) / 2}" y="48" text-anchor="middle">${marks[1].hop}</text>`;
  }
  marks.forEach((mark, index) => {
    const at = spots[index];
    const end = at > width * 0.62;
    // lift the first label if the two are close
    const top = marks.length === 2 && index === 0 && Math.abs(spots[1] - at) < 300 ? 8 : 30;
    html += `<line class="mark-line ${mark.cls}" x1="${at}" x2="${at}" y1="${top}" y2="${axis + 38}"/><circle class="mark-dot ${mark.cls}" cx="${at}" cy="${axis}" r="6"/>
      <text class="mark-label ${mark.cls}" x="${at + (end ? -12 : 12)}" y="${top + 16}" text-anchor="${end ? "end" : "start"}">${mark.label}${mark.note ? `<tspan class="mark-note" dx="8">${mark.note}</tspan>` : ""}</text>`;
  });
  // zone names on top of the marks
  svg.innerHTML = html + zones;
}

// screen: attack
function renderAttack() {
  show("tpl-attack", "attack");
  const attack = state.attack;
  const gps = attack.metadata.gps;
  // true distance if known
  const off = attack.error_km ?? (gps ? distanceKm(gps, attack.location) : null);
  const shown = off ?? attack.location.radius_km;
  const rows = findingRows(attack);
  const flagged = rows.filter((html) => html.includes("chip hot")).length;
  const status = gps ? chip("hot", "GPS gives the exact spot", true) : off != null ? chip("hot", `Located within ${km(off)} km`, true) : chip("hot", `Narrowed to about ${km(shown)} km`, true);
  crumbs("Scans", state.name);
  head(state.name, status, [`${attack.width} × ${attack.height}`, `Scanned in <b>${attack.seconds} s</b>`, "Attacker model <b>GeoCLIP</b>", plural(rows.length, "check")],
    `<button type="button" class="btn primary" id="protect">${icon("shield")}Protect this photo <span class="kb">P</span></button>`);

  app.querySelector(".attack").style.setProperty("--ar", attack.width / attack.height);
  Object.assign(document.getElementById("photo"), { src: photoUrl(attack.id), alt: photoAlt() });
  fill("marks", clueMarks(attack));
  fill("photo-credit", state.example ? creditHtml(state.example.credit) : "");
  // GeoCLIP only sees the center square
  const side = Math.min(attack.width, attack.height);
  const inset = `${((attack.height - side) / 2 / attack.height) * 100}% ${((attack.width - side) / 2 / attack.width) * 100}%`;
  document.getElementById("heat-layer").style.setProperty("--inset", inset);
  paintHeat(attack.heat);
  setView(state.view);
  fill("findings", rows.join(""));
  fill("flag-count", `${flagged} of ${rows.length} flagged`);
  const top = attack.location.top[0];
  fill("stats", stat(gps ? "AI guess" : "Guess", coords(attack.location), "", "mono")
    + stat("Radius shown", `${km(attack.location.radius_km)} km`, "Never a pin")
    + (off != null
      ? stat(gps ? "AI alone is off by" : "Actually off by", `${km(off)} km`, capital(zoneOf(off)[3]), "hot")
      : stat("Confidence", `${(top.prob * 100).toFixed(1)}<small>%</small>`, "Top guess")));
  fill("score-box", scoreHtml(attack.score));
  drawRuler([off != null
    ? { km: off, cls: "hot", label: `${km(off)} km`, note: zoneOf(off)[3] }
    : { km: shown, cls: "hot", label: `~${km(shown)} km`, note: "area the guess covers" }]);
  document.getElementById("mode-heat").addEventListener("click", () => photoMode("heat"));
  document.getElementById("mode-text").addEventListener("click", () => photoMode("text"));
  document.getElementById("mode-original").addEventListener("click", () => photoMode("original"));
  document.getElementById("protect").addEventListener("click", protectPhoto);
  document.getElementById("new").addEventListener("click", renderStart);
  say("Attack finished. " + document.getElementById("title").textContent);
  showAttackMap(attack, gps).then(() => {
    if (gps && geo && document.getElementById("gps-place")) fill("gps-place", esc(regionName([gps.lon, gps.lat], 25).split(",")[0]));
  });
}

// short credit, full link on hover
function creditHtml(credit) {
  const link = credit.match(/\s*\((https?:\/\/\S+)\)/);
  if (!link) return esc(credit);
  const short = credit.replace(link[0], "").replace(" via ", " ");
  return `<a href="${esc(link[1])}" title="${esc(link[1])}" target="_blank" rel="noopener">${esc(short)}</a>`;
}

// send the photo to be protected
function protectPhoto() {
  const attack = state.attack;
  const options = {
    blur_text: document.getElementById("opt-text").checked,
    blur_faces: document.getElementById("opt-faces").checked,
    cloak: document.getElementById("opt-cloak").checked,
  };
  state.options = options;
  const plan = [
    options.blur_text && attack.text.length && "Blur " + plural(attack.text.length, "piece") + " of readable text",
    options.blur_faces && attack.faces.length && "Blur " + plural(attack.faces.length, "face"),
    options.cloak && "Nudge pixels by at most 4 of 255 until GeoCLIP guesses wrong",
    "Save a clean JPEG with no metadata",
    "Attack the saved file again to check",
  ].filter(Boolean);
  const title = options.cloak ? "Computing the invisible cloak" : "Protecting your photo";
  const detail = options.cloak ? "Usually 30 to 60 seconds. Everything runs on this laptop." : "Everything runs on this laptop.";
  renderWait(title, detail, preview(photoUrl(attack.id), photoAlt()), plan, "protect");
  return postForm("protect", { id: attack.id, ...options })
    .then((result) => { state.protect = result; renderProtected(); })
    .catch((error) => renderError(error.message));
}

// rows for what protect changed
function changeRows(attack, protect, options, newPlace) {
  const after = protect.after;
  const known = !!(attack.truth || attack.metadata.gps);
  const rows = [];
  const texts = attack.text.length;
  if (options.blur_text && texts) {
    rows.push(after.text.length
      ? row("alert", "hot", "Text still readable", `In ${plural(after.text.length, "place")} after blurring`, chip("hot", "Check"))
      : row("unread", "ok", "Text blurred", `${plural(texts, "text clue")} no longer readable`, chip("ok", "Done")));
  } else rows.push(row("text", "", "Text", texts ? "Left as it was" : "None to blur", chip("mute", "Skipped")));
  const faces = attack.faces.length;
  if (options.blur_faces && faces) rows.push(row("face", "ok", plural(faces, "face") + " blurred", "People can't be recognized", chip("ok", "Done")));
  else rows.push(row("face", "", "Faces", faces ? "Left as they were" : "None to blur", chip("mute", "Skipped")));
  if (options.cloak) rows.push(row("cloak", "ok", "Invisible cloak added", 'Max <b class="num">4/255</b> per pixel, less in smooth areas', chip("ok", "Done"), "wrap"));
  else rows.push(row("cloak", "", "Invisible cloak", "Pixels not changed", chip("mute", "Skipped")));
  const meta = attack.metadata;
  const fields = ["gps", "camera", "taken"].filter((name) => meta[name]).length + meta.other.length;
  rows.push(after.metadata_found
    ? row("alert", "hot", "Metadata still found", "In the saved file", chip("hot", "Check"))
    : row("file", "ok", "Metadata stripped", `${fields ? plural(fields, "field") + " removed, " : ""}file re-read: nothing left`, chip("ok", "Verified")));
  const label = known ? `${km(after.error_km)} km off` : `Moved ${km(after.error_km)} km`;
  rows.push(row("again", "ok", "Attacked again", `Now guesses ${esc(newPlace)}`, chip(after.error_km >= 100 ? "ok" : "mute", label)));
  return rows;
}

// plain note on what protect can't fix
function honestText(attack, options, moved) {
  const leftovers = attack.ambient.map(clueText).join(", ") || "the buildings and scenery";
  let cloak = "";
  if (options.cloak) cloak = moved ? "The cloak fools GeoCLIP, an open model. " : "The cloak didn't move GeoCLIP's guess far on this photo. ";
  else cloak = "The pixels weren't cloaked, so GeoCLIP can still place it. ";
  return esc(cloak + `Commercial AI like ChatGPT or Claude may still recognize ${leftovers}. If this place matters, crop it out.`);
}

// move the compare line, 0 to 100
function setSplit(percent) {
  const value = Math.min(100, Math.max(0, percent));
  document.getElementById("shot").style.setProperty("--x", value + "%");
  document.getElementById("handle").setAttribute("aria-valuenow", Math.round(value));
}

// drag on the photo to compare
function hookCompare() {
  const shot = document.getElementById("shot");
  // pointer x as a percent of the photo
  const move = (event) => {
    const box = shot.getBoundingClientRect();
    setSplit(((event.clientX - box.left) / box.width) * 100);
  };
  // whole panel is the drag area
  const panel = shot.parentElement;
  // stop the browser dragging the image itself
  panel.addEventListener("dragstart", (event) => event.preventDefault());
  panel.addEventListener("pointerdown", (event) => { event.preventDefault(); panel.setPointerCapture(event.pointerId); move(event); });
  panel.addEventListener("pointermove", (event) => { if (panel.hasPointerCapture(event.pointerId)) move(event); });
  setSplit(50);
}

// screen: protected
function renderProtected() {
  show("tpl-protected", "protect");
  const { attack, protect, options } = state;
  const moved = options.cloak && protect.after.error_moved_km >= 100;
  const known = !!(attack.truth || attack.metadata.gps);
  const before = protect.before.location;
  const after = protect.after.location;
  const newPlace = geo ? regionName([after.lon, after.lat], 500) : "somewhere else";
  const clean = !protect.after.metadata_found;
  crumbs("Scans", state.name);
  head(state.name, clean ? chip("ok", "Protected", true) : chip("hot", "Metadata still found", true),
    [`Protected in <b>${protect.seconds} s</b>`, "Re-attacked with <b>GeoCLIP</b>", clean ? "Metadata verified empty" : "Metadata check failed"],
    `<a class="btn primary" id="save" href="protected/${encodeURIComponent(attack.id)}.jpg" download="unmapped.jpg">${icon("download")}Download clean copy <span class="kb">D</span></a>`);

  app.querySelector(".protected").style.setProperty("--ar", attack.width / attack.height);
  document.getElementById("before").src = photoUrl(attack.id);
  document.getElementById("after").src = "data:image/jpeg;base64," + protect.image_jpeg;
  const blurred = [...(options.blur_text ? attack.text : []), ...(options.blur_faces ? attack.faces : [])];
  fill("blurs", blurred.map((item) => `<div class="blurmark" style="${boxStyle(item.box, attack)}"></div>`).join(""));
  fill("blur-labels", boxLabels(blurred.slice(0, 1).map((item) => ({ box: item.box, text: item.text ? "Text blurred" : "Face blurred" })), attack, "check"));
  hookCompare();
  const rows = changeRows(attack, protect, options, newPlace);
  fill("checks", rows.join(""));
  fill("step-count", `${plural(rows.filter((html) => !html.includes("Skipped")).length, "step")}, re-attacked`);
  const top = after.top[0];
  fill("stats", stat("New guess", coords(after), "", "mono")
    + stat("Confidence", `${(top.prob * 100).toFixed(1)}<small>%</small>`, "Top guess")
    + (known
      ? stat("Now off by", `${km(protect.after.error_km)} km`, `Was ${km(protect.before.error_km)} km`, moved ? "safe" : "")
      : stat("Guess moved", `${km(protect.after.error_km)} km`, "True spot unknown", moved ? "safe" : "")));
  fill("score-box", scoreHtml(protect.score_after, protect.score_before));
  const ratio = protect.after.error_km / Math.max(protect.before.error_km, 0.1);
  if (!known) fill("ruler-title", "How far the guess moved");
  drawRuler([
    { km: protect.before.error_km, cls: "was", label: known ? `Before ${km(protect.before.error_km)} km` : "Before" },
    { km: protect.after.error_km, cls: moved ? "safe" : "hot", label: `${km(protect.after.error_km)} km`, hop: ratio >= 2 ? `${Math.round(ratio).toLocaleString("en-US")}× farther away` : "" },
  ]);
  fill("honest", honestText(attack, options, moved));
  document.getElementById("again").addEventListener("click", renderStart);
  document.getElementById("claude-test").addEventListener("click", testClaude);
  if (!state.claude) fill("claude-out", `<span class="fine">Claude check is off: no Anthropic API key on this laptop, so nothing is sent.</span>`);
  say("Protection finished. GeoCLIP now guesses " + newPlace + ".");
  showFlightMap(before, after, moved);
}

// one line of Claude's answer
function claudeLine(label, answer) {
  if (answer.refused) return `<p class="cl"><span class="sl">${label}</span> declined to guess</p>`;
  const off = answer.error_km != null ? `<b class="num">${km(answer.error_km)} km off</b> ` : "";
  return `<p class="cl" title="${esc(answer.place)}"><span class="sl">${label}</span> ${off}${esc(answer.place)}</p>`;
}

// opt-in: asks Claude about both photos
async function testClaude() {
  const button = document.getElementById("claude-test");
  button.disabled = true;
  button.textContent = "Asking Claude...";
  try {
    const answers = await Promise.all(["original", "protected"].map((which) => postForm("claude_check", { id: state.attack.id, which })));
    fill("claude-out", `<div class="cl-res"><p class="cl-head">Claude, a commercial AI</p>${claudeLine("Original", answers[0])}${claudeLine("Protected", answers[1])}</div>`);
    const still = answers[1].error_km != null && answers[1].error_km < 50;
    if (still) fill("honest", "<b>Claude still found it.</b> The cloak is tuned to fool the open model, not every AI. If this place matters, crop it out.");
    say("Claude check finished.");
  } catch (error) {
    button.disabled = false;
    button.textContent = "Check with Claude";
    document.getElementById("claude-out").insertAdjacentHTML("beforeend", `<p class="notice" role="alert">${esc(error.message)}</p>`);
  }
}

// screen: profile feed
function renderFeed() {
  show("tpl-feed", "profile");
  const feed = state.feed;
  crumbs("Profiles", "New feed");
  head("Profile", "", ["Add 5 to 10 photos from one account, with their captions", "Runs on this laptop"],
    `<button type="button" class="btn primary" id="run-profile">${icon("again")}Attack this feed</button>`);
  fill("posts", feed.length
    ? `<ol class="posts">${feed.map(postRow).join("")}</ol>`
    : `<div class="empty"><span class="drop-ico" aria-hidden="true">${icon("upload")}</span><p class="empty-title">Drop photos here</p><p class="fine">Or click Add photos. JPEG, PNG or iPhone HEIC.</p></div>`);
  fill("feed-count", `${feed.length} of 10${feed.length < 5 ? ", add at least 5" : ""}`);
  const count = feedExamples().length;
  fill("example-note", count ? `${count} public photos around Huntington Beach, posted by a fictional teen` : "");
  fill("sample", feedExamples().map((example) => `<img src="${exampleUrl(example.id)}" alt="">`).join(""));
  document.getElementById("run-profile").disabled = feed.length < 5;
  document.getElementById("add").addEventListener("click", () => pickFiles("pick-many", addFeedFiles));
  hookDrop(document.getElementById("feed-drop"), addFeedFiles);
  document.getElementById("example-feed").addEventListener("click", loadExampleFeed);
  document.getElementById("run-profile").addEventListener("click", runProfile);
  // one listener for every row
  const posts = document.getElementById("posts");
  posts.addEventListener("input", (event) => (feed[event.target.dataset.caption].caption = event.target.value));
  posts.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove]");
    if (button) { feed.splice(Number(button.dataset.remove), 1); renderFeed(); }
  });
}

// small preview of a post
function thumb(post) { return isHeic(post.name) ? `<span class="heic">HEIC</span>` : `<img src="${post.url}" alt="">`; }

// one row of the feed
function postRow(post, index) {
  return `<li class="post">
    ${thumb(post)}
    <label><span class="sr">Caption for photo ${index + 1}</span>
      <input type="text" data-caption="${index}" value="${esc(post.caption)}" placeholder="Caption (optional)"></label>
    <button type="button" class="remove" data-remove="${index}" aria-label="Remove photo ${index + 1}">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15"/></svg>
    </button>
  </li>`;
}

// add files to the feed
function addFeedFiles(files) {
  files.filter(isImage).forEach((file) => {
    if (state.feed.length < 10) state.feed.push({ file, name: file.name, caption: "", url: URL.createObjectURL(file) });
  });
  renderFeed();
}

// fill the feed with examples
function loadExampleFeed() {
  const picks = feedExamples();
  if (!picks.length) return renderError(state.examplesError || "The server has no example feed.");
  state.posts = picks.map((example) => ({ name: example.id + ".jpg", caption: example.caption || "", url: exampleUrl(example.id) }));
  state.feedName = "Example feed";
  return attackFeed(getJson("profile_example", { method: "POST" }));
}

// send the feed to the server
function runProfile() {
  // one image and caption per photo
  const form = new FormData();
  state.feed.forEach((post) => {
    form.append("images", post.file, post.name);
    form.append("captions", post.caption);
  });
  state.posts = state.feed;
  state.feedName = "Your feed";
  return attackFeed(getJson("profile", { method: "POST", body: form }));
}

// show the profile result
function attackFeed(request) {
  const left = `<div class="thumbs">${state.posts.map(thumb).join("")}</div>`;
  const plan = ["GeoCLIP guesses each photo on its own", "Multiply the guesses together", "Scan captions for school, team, home and routine"];
  renderWait("Attacking the whole feed", "About a second per photo.", left, plan, "profile");
  return request.then((result) => { state.profile = result; renderProfile(); }).catch((error) => renderError(error.message));
}

// mark flagged words in a caption
function highlight(caption, flags) {
  let html = esc(caption);
  new Set(flags.map((flag) => esc(flag.match))).forEach((word) => (html = html.split(word).join(`<mark>${word}</mark>`)));
  return html;
}

const COUNTS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

// screen: profile result
function renderProfile() {
  show("tpl-profile", "profile");
  const profile = state.profile;
  const photos = profile.photos;
  // true distance or area size
  const known = profile.error_km != null;
  const values = photos.map((photo) => (known ? photo.error_km : photo.location.radius_km));
  const alone = median(values);
  const together = known ? profile.error_km : profile.combined.radius_km;
  const count = COUNTS[photos.length] || photos.length;
  const flagCount = profile.captions.reduce((total, item) => total + item.flags.length, 0);
  crumbs("Profiles", state.feedName);
  head(state.feedName, chip("hot", `${known ? "Located within" : "Narrowed to about"} ${km(together)} km`, true),
    [plural(photos.length, "photo"), `Scanned in <b>${profile.seconds} s</b>`, plural(flagCount, "caption clue")],
    `<button type="button" class="btn ghost" id="edit">Edit feed</button>`);
  fill("alone-label", known ? "Each photo alone misses by" : "Each photo alone narrows to");
  fill("together-label", `All ${count.toLowerCase()} together ${known ? "miss by" : "narrow to"}`);
  fill("alone", kmNum(alone, known ? "" : "~"));
  fill("together", kmNum(together, known ? "" : "~"));
  fill("score-box", scoreHtml(profile.score).replace("Privacy score", "Profile score"));
  fill("flagged", `${plural(flagCount, "clue")} in ${plural(profile.captions.filter((item) => item.caption).length, "caption")}`);
  fill("caplist", state.posts.map((post, index) => {
    const scan = profile.captions.find((item) => item.caption === post.caption) || { flags: [] };
    const text = post.caption.trim() ? highlight(post.caption, scan.flags) : `<span class="fine">No caption</span>`;
    return `<li><span class="cn">${index + 1}</span><span>${text}</span></li>`;
  }).join(""));
  document.getElementById("edit").addEventListener("click", renderFeed);
  say(`Profile finished. Each photo alone about ${km(alone)} km, together ${known ? "" : "about "}${km(together)} km.`);
  drawAxis(values, alone, together, known);
  showProfileMap(profile);
}

// thumbs hung on a log scale
function drawAxis(values, alone, together, known) {
  const svg = document.getElementById("axis");
  const width = svg.clientWidth;
  const axisY = svg.clientHeight - 84;
  svg.setAttribute("viewBox", `0 0 ${width} ${svg.clientHeight}`);
  const x = d3.scaleLog().domain([1, 20000]).range([40, width - 50]).clamp(true);
  const w = 120, h = 80, gap = 12, top = 34;
  // sort by distance, then push apart
  const order = d3.sort(d3.range(values.length), (i) => values[i]);
  const lefts = [];
  order.forEach((i, k) => (lefts[k] = Math.max(x(values[i]) - w / 2, k ? lefts[k - 1] + w + gap : 0)));
  for (let k = order.length - 1; k >= 0; k--) lefts[k] = Math.min(lefts[k], k < order.length - 1 ? lefts[k + 1] - w - gap : width - w);
  let html = `<line class="axis" x1="${x(1)}" x2="${x(20000)}" y1="${axisY}" y2="${axisY}"/>`;
  x.ticks().forEach((tick) => {
    const major = Number.isInteger(Math.log10(tick));
    html += `<line class="axis${major ? "" : " minor"}" x1="${x(tick)}" x2="${x(tick)}" y1="${axisY + (major ? 8 : 0)}" y2="${axisY - (major ? 12 : 6)}"/>`;
    if (major) html += `<text class="ax-label" x="${x(tick)}" y="${axisY + 36}" text-anchor="middle">${tick.toLocaleString("en-US")} km</text>`;
  });
  order.forEach((i, k) => {
    const post = state.posts[i];
    const left = lefts[k];
    const value = x(values[i]);
    // longer leads bend lower, so they never cross
    const elbow = top + h + 8 + Math.min(20, Math.abs(left + w / 2 - value) / 12);
    html += `<path class="hang" d="M${value} ${axisY}V${elbow}H${left + w / 2}V${top + h}"/><circle class="hang-dot" cx="${value}" cy="${axisY}" r="5"/>
      <text class="thumb-km" x="${left + w / 2}" y="${top - 10}" text-anchor="middle">${known ? "" : "~"}${km(values[i])} km</text>
      ${isHeic(post.name) ? `<rect class="heic" x="${left}" y="${top}" width="${w}" height="${h}" rx="6"/>` : `<image href="${post.url}" x="${left}" y="${top}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" clip-path="inset(0 round 6px)"/>`}
      <rect class="frame" x="${left}" y="${top}" width="${w}" height="${h}" rx="6"/>
      <rect class="badge" x="${left + 6}" y="${top + 6}" width="28" height="28" rx="6"/><text class="badge-n" x="${left + 20}" y="${top + 26}" text-anchor="middle">${i + 1}</text>`;
  });
  html += `<line class="median" x1="${x(alone)}" x2="${x(alone)}" y1="${axisY - 26}" y2="${axisY + 50}"/>
    <text class="ax-note" x="${x(alone) + 10}" y="${axisY + 70}">median alone, ${km(alone)} km</text>
    <line class="comb" x1="${x(together)}" x2="${x(together)}" y1="${axisY - 34}" y2="${axisY + 50}"/>
    <path class="comb" d="M${x(together)} ${axisY - 9}l9 9-9 9-9-9Z"/>
    <text class="ax-note strong" x="${x(together) - 10}" y="${axisY + 70}" text-anchor="end">together, ${km(together)} km</text>`;
  svg.innerHTML = html;
}

// offline map data
async function loadGeo() {
  if (geo) return;
  const [world, us] = await Promise.all(["countries-50m.json", "counties-10m.json"].map((name) => getJson("vendor/" + name)));
  const notUs = world.objects.countries.geometries.filter((country) => country.id !== "840");
  geo = {
    countries: topojson.feature(world, world.objects.countries).features,
    // finer US coast
    land: { type: "FeatureCollection", features: [{ type: "Feature", geometry: topojson.merge(world, notUs) }, ...topojson.feature(us, us.objects.nation).features] },
    borders: topojson.mesh(world, world.objects.countries, (a, b) => a !== b),
    states: topojson.feature(us, us.objects.states).features,
    stateLines: topojson.mesh(us, us.objects.states, (a, b) => a !== b),
    counties: topojson.feature(us, us.objects.counties).features,
    countyLines: topojson.mesh(us, us.objects.counties, (a, b) => a !== b),
  };
}

// name the region of a point
function regionName(point, radius) {
  if (!geo) return "this area";
  const inside = (features) => features.find((feature) => d3.geoContains(feature, point));
  const usState = inside(geo.states);
  if (usState && radius <= 25) {
    const county = inside(geo.counties);
    if (county) return county.properties.name + " County, " + usState.properties.name;
  }
  if (usState && radius <= 500) return usState.properties.name;
  const country = inside(geo.countries) || nearestCountry(point);
  return country ? country.properties.name : "open water";
}

// coastal guesses can land just offshore
function nearestCountry(point) {
  const nearest = d3.least(geo.countries, (country) => d3.geoDistance(point, d3.geoCentroid(country)));
  return d3.geoDistance(point, d3.geoCentroid(nearest)) * 6371 < 1500 ? nearest : null;
}

// map svg, null if data is missing
async function mapSvg(credit) {
  const box = document.getElementById("map-box");
  try {
    await loadGeo();
  } catch (error) {
    box.insertAdjacentHTML("afterbegin", `<p class="pad notice">Map files are missing from frontend/vendor.</p>`);
    return null;
  }
  if (!box.isConnected) return null;
  box.insertAdjacentHTML("afterbegin", `<svg class="map" role="img" aria-label="Map with the guessed area drawn as a circle, never a pin"></svg>`);
  fill("map-credit", credit);
  return box.querySelector("svg");
}

// land, borders and US lines
function geoLayers(path, viewKm) {
  let html = `<path class="land" d="${path(geo.land)}"/>`;
  if (viewKm < 700) html += `<path class="county" d="${path(geo.countyLines)}"/>`;
  if (viewKm < 5000) html += `<path class="state" d="${path(geo.stateLines)}"/>`;
  return html + `<path class="border" d="${path(geo.borders)}"/>`;
}

// Mercator with a fixed km scale
function mercator(center, pxPerKm, at, clip) {
  const scale = pxPerKm * 6371 * Math.cos((center.lat * Math.PI) / 180);
  return d3.geoMercator().center([center.lon, center.lat]).scale(scale).translate(at).clipExtent(clip);
}

// lat/lon lines across the map
function gridLines(projection, width, height) {
  const [west, north] = projection.invert([0, 0]);
  const [east, south] = projection.invert([width, height]);
  const step = [1 / 60, 1 / 30, 1 / 12, 1 / 6, 1 / 4, 1 / 2, 1, 2, 5, 10, 15, 30].find((s) => (east - west) / s <= 8) || 30;
  const grid = d3.geoGraticule().step([step, step]).extent([[west - step, south - step], [east + step, north + step]]);
  return `<path class="grat" d="${pathOf(projection)(grid())}"/>`;
}

// path maker that never returns null
function pathOf(projection) {
  const path = d3.geoPath(projection);
  return (shape) => path(shape) || "";
}

// circle shape around a point
function circle(point, radiusKm) { return d3.geoCircle().center([point.lon, point.lat]).radius(radiusKm / 111.2)(); }

// which distance rings to draw, in km
function keptRings(area, pxPerKm, maxKm) {
  const kept = [];
  [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].forEach((ring) => {
    const last = kept[kept.length - 1] || area.radius_km;
    if (ring >= area.radius_km * 2 && ring <= maxKm && (ring - last) * pxPerKm >= 46 && kept.length < 2) kept.push(ring);
  });
  return kept;
}

// dashed distance rings, labeled up and right
function distanceRings(path, projection, area, pxPerKm, maxKm) {
  return keptRings(area, pxPerKm, maxKm).map((ring) => {
    const step = (ring / 111.2) * Math.SQRT1_2;
    const [x, y] = projection([area.lon + step / Math.cos((area.lat * Math.PI) / 180), area.lat + step]);
    const label = y > 30 ? `<text class="range-label" x="${x + 6}" y="${y - 6}">${km(ring)} km</text>` : "";
    return `<path class="range" d="${path(circle(area, ring))}"/>${label}`;
  }).join("");
}

// draw the guess circle
function guessCircle(path, area) {
  const d = path(circle(area, area.radius_km));
  return `<path class="guess-halo" d="${d}"/><path class="guess" d="${d}"/>`;
}

// html label beside a map point
function pillAt([x, y], width, html, cls = "", dy = 0) {
  // above or below: centered on the point
  if (dy) return `<p class="pill at mid ${cls}" style="left:${x}px;top:${y + dy}px">${html}</p>`;
  const flip = x > width * 0.6;
  return `<p class="pill at ${cls}${flip ? " flip" : ""}" style="left:${x + (flip ? -20 : 20)}px;top:${y}px">${html}</p>`;
}

// regional chart around a guess
function chart(svg, area, halfKm, center) {
  const [width, height] = [svg.clientWidth, svg.clientHeight];
  const pxPerKm = (width * 0.5) / halfKm;
  const projection = mercator(center, pxPerKm, [width / 2, height / 2], [[-40, -40], [width + 40, height + 40]]);
  const path = pathOf(projection);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const html = `<rect class="sea" width="${width}" height="${height}"/>${gridLines(projection, width, height)}${geoLayers(path, halfKm)}
    ${distanceRings(path, projection, area, pxPerKm, halfKm * 0.9)}${guessCircle(path, area)}`;
  return { width, height, pxPerKm, projection, html };
}

// draw the attack map
async function showAttackMap(attack, gps) {
  const svg = await mapSvg("Map: Mercator, Natural Earth, US Census Bureau");
  if (!svg) return;
  const box = document.getElementById("map-box");
  const area = attack.location;
  // no county lines abroad, so show more coast
  const abroad = !geo.states.some((usState) => d3.geoContains(usState, [area.lon, area.lat]));
  const far = gps ? distanceKm(gps, area) * (svg.clientWidth / svg.clientHeight) : 0;
  const halfKm = Math.min(Math.max(area.radius_km * 5, abroad ? 300 : 150, far), 6000);
  const center = gps ? { lon: (gps.lon + area.lon) / 2, lat: (gps.lat + area.lat) / 2 } : area;
  const map = chart(svg, area, halfKm, center);
  const [cx, cy] = map.projection([area.lon, area.lat]);
  let html = map.html + (area.radius_km * map.pxPerKm < 12 ? `<circle class="guess-sm" cx="${cx}" cy="${cy}" r="12"/>` : "");
  let pills = `<p class="pill corner"><i class="dot hot"></i>${esc(regionName([area.lon, area.lat], area.radius_km))}</p>`;
  if (gps) {
    const spot = map.projection([gps.lon, gps.lat]);
    html += `<g class="gps-cross" transform="translate(${spot[0]} ${spot[1]})"><path class="halo" d="M-14 0H14M0-14V14"/><path d="M-14 0H14M0-14V14"/><circle r="5"/></g>`;
    pills += pillAt(spot, map.width, "GPS in the file", "ink");
  }
  svg.innerHTML = html;
  box.insertAdjacentHTML("beforeend", pills);
}

// whole world, or zoomed in on a short arc
function flightProjection(a, b, mid, size) {
  const reach = Math.max((d3.geoDistance(a, b) * 180) / Math.PI * 0.7, 10);
  const view = reach > 45 ? { type: "Sphere" } : d3.geoCircle().center(mid).radius(reach)();
  return d3.geoEqualEarth().rotate([-mid[0], 0]).fitExtent([[12, 12], [size[0] - 12, size[1] - 12]], view);
}

// world map with the guess flying away
async function showFlightMap(before, after, moved) {
  const svg = await mapSvg("Map: Equal Earth, Natural Earth");
  if (!svg) return;
  const box = document.getElementById("map-box");
  const size = [svg.clientWidth, svg.clientHeight];
  const a = [before.lon, before.lat];
  const b = [after.lon, after.lat];
  const arc = { type: "LineString", coordinates: d3.range(0, 1.0001, 1 / 64).map(d3.geoInterpolate(a, b)) };
  const projection = flightProjection(a, b, d3.geoInterpolate(a, b)(0.5), size);
  const path = pathOf(projection);
  const [pa, pb] = [projection(a), projection(b)];
  svg.setAttribute("viewBox", `0 0 ${size[0]} ${size[1]}`);
  const sphere = path({ type: "Sphere" });
  // the other top guesses, sized by chance
  const others = after.top.slice(1).map((guess) => {
    const [x, y] = projection([guess.lon, guess.lat]);
    return `<circle class="other" cx="${x}" cy="${y}" r="${3 + guess.prob * 20}"/>`;
  }).join("");
  svg.innerHTML = `<clipPath id="globe"><path d="${sphere}"/></clipPath><path class="globe" d="${sphere}"/>
    <g clip-path="url(#globe)"><path class="grat" d="${path(d3.geoGraticule().step([30, 30])())}"/>${geoLayers(path, 9000)}</g>
    <path class="sphere" d="${sphere}"/>
    <path class="arc" d="${path(arc)}"/>
    <circle class="old-ring" cx="${pa[0]}" cy="${pa[1]}" r="9"/><circle class="old-core" cx="${pa[0]}" cy="${pa[1]}" r="3"/>
    ${others}<circle class="new-ring" cx="${pb[0]}" cy="${pb[1]}" r="24"/>`;
  const oldName = regionName(a, before.radius_km).split(",")[0];
  const newName = regionName(b, 500);
  // same height: one pill above, one below
  const dy = Math.abs(pa[1] - pb[1]) < 60 ? 46 : 0;
  box.insertAdjacentHTML("beforeend", pillAt(pa, size[0], "Was: " + esc(oldName), "muted", dy)
    + pillAt(pb, size[0], `<i class="dot ${moved ? "safe" : "hot"}"></i>Now: ${esc(newName)}`, "", -dy));
}

// regional map with every photo's guess
async function showProfileMap(profile) {
  const svg = await mapSvg("Map: Mercator, Natural Earth, US Census Bureau");
  if (!svg) return;
  const box = document.getElementById("map-box");
  const area = profile.combined;
  const guesses = profile.photos.map((photo) => [photo.location.lon, photo.location.lat]);
  const map = chart(svg, area, Math.max(area.radius_km * 4, 300), area);
  // nearby pills share one label
  const pills = [];
  let offMap = 0;
  guesses.forEach((point, index) => {
    const [x, y] = map.projection(point);
    if (x < 20 || x > map.width - 20 || y < 20 || y > map.height - 20) return offMap++;
    const near = pills.find((pill) => Math.hypot(pill.x - x, pill.y - y) < 40);
    if (near) near.labels.push(index + 1);
    else pills.push({ x, y, labels: [index + 1] });
  });
  const pillHtml = pills.map((pill) => {
    const text = pill.labels.join(", ");
    const w = 18 + text.length * 11;
    return `<g class="pmark" transform="translate(${pill.x} ${pill.y})"><rect x="${-w / 2}" y="-15" width="${w}" height="30" rx="15"/><text y="7" text-anchor="middle">${text}</text></g>`;
  }).join("");
  svg.innerHTML = map.html + pillHtml;
  const name = regionName([area.lon, area.lat], area.radius_km);
  box.insertAdjacentHTML("beforeend", `<p class="pill corner"><i class="dot hot"></i>${esc(name)}, within about ${km(area.radius_km)} km</p>`);
  if (offMap) fill("map-aside", `Pills: each photo's guess, ${offMap} off this map`);
}

// keyboard shortcuts shown in the UI
function onKey(event) {
  if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    return openPhoto();
  }
  if (event.metaKey || event.ctrlKey || event.altKey || event.target.closest("input, textarea")) return;
  const key = event.key.toLowerCase();
  const click = (id) => document.getElementById(id) && !document.getElementById(id).disabled && document.getElementById(id).click();
  if (key === "1") click("tab-attack");
  if (key === "2") click("tab-protect");
  if (key === "3") click("tab-profile");
  if (key === "p") click("protect");
  if (key === "d") click("save");
  if (state.screen === "tpl-attack" && key === "h") photoMode("heat");
  if (state.screen === "tpl-attack" && key === "t") photoMode("text");
  if (state.screen === "tpl-attack" && key === "o") photoMode("original");
  if (state.screen === "tpl-protected" && (key === "arrowleft" || key === "arrowright")) {
    event.preventDefault();
    const now = Number(document.getElementById("handle").getAttribute("aria-valuenow"));
    setSplit(now + (key === "arrowleft" ? -5 : 5));
  }
}

// start the app
async function init() {
  fitStage();
  window.addEventListener("resize", fitStage);
  let theme = "light";
  try { theme = localStorage.getItem("theme") || "light"; } catch (error) {}
  setTheme(theme);
  if (!/Mac|iPhone|iPad/.test(navigator.platform)) fill("cmd-key", "Ctrl K");
  document.getElementById("theme").addEventListener("click", () => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
  document.getElementById("cmd").addEventListener("click", openPhoto);
  document.addEventListener("keydown", onKey);
  document.getElementById("tab-attack").addEventListener("click", () => (state.attack ? renderAttack() : renderStart()));
  document.getElementById("tab-protect").addEventListener("click", renderProtected);
  document.getElementById("tab-profile").addEventListener("click", () => (state.profile ? renderProfile() : renderFeed()));
  renderStart();
  try { state.examples = await getJson("examples"); } catch (error) { state.examplesError = error.message; }
  try { state.claude = (await getJson("config")).claude === true; } catch (error) {}
  loadGeo().catch(() => {});
  showExamples();
}

init();
