const app = document.getElementById("app");
const state = {
  mode: "single", // which tab
  examples: [], // built-in photos
  examplesError: null, // why examples failed
  claude: false, // Claude check allowed
  example: null, // chosen example
  attack: null, // attack result
  options: null, // protect checkboxes
  protect: null, // protect result
  feed: [], // profile photos
  profile: null, // profile result
};
let timer = null;

// small helpers
function esc(text) {
  return String(text).replace(/[&<>"']/g, (char) => "&#" + char.charCodeAt(0) + ";");
}

function km(value) {
  if (value < 10) return value.toFixed(1).replace(/\.0$/, "");
  return Math.round(value).toLocaleString("en-US");
}

// tight commas in big mono numbers
function bigKm(value) {
  return km(value).replace(/[.,]/g, `<span class="c">$&</span>`);
}

function kmHot(value, approx) {
  return `<span class="hot nowrap"><span class="mono">${approx ? "~" : ""}${bigKm(value)}</span> km</span>`;
}

function plural(count, word) {
  return count + " " + word + (count === 1 ? "" : "s");
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function clueText(clue) {
  return clue.clue.replace(/^looks like (a |an )?/i, "");
}

function isImage(file) {
  return /^image\//.test(file.type) || /\.(heic|heif)$/i.test(file.name);
}

function isHeic(name) {
  return /\.(heic|heif)$/i.test(name);
}

function photoUrl(id) {
  return "photo/" + encodeURIComponent(id) + ".jpg";
}

function exampleUrl(id) {
  return "example_image/" + encodeURIComponent(id) + ".jpg";
}

function fill(id, html) {
  document.getElementById(id).innerHTML = html;
}

function say(text) {
  document.getElementById("say").textContent = text;
}

function distanceKm(a, b) {
  return d3.geoDistance([a.lon, a.lat], [b.lon, b.lat]) * 6371;
}

// the real spot, when known
function trueSpot(attack) {
  return attack.truth || attack.metadata.gps;
}

function errorKm(attack) {
  if (attack.error_km != null) return attack.error_km;
  return attack.metadata.gps ? distanceKm(attack.metadata.gps, attack.location) : null;
}

function scoreWord(score) {
  if (score < 40) return "exposed";
  if (score < 75) return "at risk";
  return "safer";
}

// server calls
async function api(path, options) {
  let response;
  try {
    response = await fetch(path, options);
  } catch (error) {
    throw new Error("Can't reach the Unmapped server. Start it on this laptop, then reload the page.");
  }
  if (!response.ok) {
    let detail = "The server returned error " + response.status + ".";
    try {
      const body = await response.json();
      if (typeof body.detail === "string") detail = body.detail;
    } catch (error) {}
    throw new Error(detail);
  }
  return response;
}

async function getJson(path, options) {
  return (await api(path, options)).json();
}

function postForm(path, fields) {
  const form = new FormData();
  Object.entries(fields).forEach(([key, value]) => form.append(key, value));
  return getJson(path, { method: "POST", body: form });
}

// theme
function savedTheme() {
  try { return localStorage.getItem("theme") || "dark"; } catch (error) { return "dark"; }
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const next = theme === "dark" ? "light" : "dark";
  document.getElementById("theme").setAttribute("aria-label", "Switch to " + next + " theme");
  try { localStorage.setItem("theme", theme); } catch (error) {}
}

// scale the 1920x1080 layout to any projector
function fitStage() {
  const zoom = innerWidth >= 1000 ? Math.min(innerWidth / 1920, innerHeight / 1080) : 1;
  document.body.style.zoom = zoom;
  document.documentElement.style.setProperty("--stage-w", innerWidth / zoom + "px");
  document.documentElement.style.setProperty("--stage-h", innerHeight / zoom + "px");
}

// top bar
function setMode(mode) {
  state.mode = mode;
  state.attack = null;
  state.protect = null;
  document.getElementById("tab-single").setAttribute("aria-pressed", mode === "single");
  document.getElementById("tab-profile").setAttribute("aria-pressed", mode === "profile");
  if (mode === "single") renderStart();
  else renderFeed();
}

function setStep(step) {
  document.getElementById("steps").hidden = !step;
  document.getElementById("step-attack").classList.toggle("on", step === "attack");
  document.getElementById("step-protected").classList.toggle("on", step === "protected");
}

// swap in a screen
function show(templateId, step) {
  stopTimer();
  setStep(step);
  app.replaceChildren(document.getElementById(templateId).content.cloneNode(true));
  app.querySelector("h1").focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function startTimer() {
  const start = Date.now();
  timer = setInterval(() => {
    fill("elapsed", Math.floor((Date.now() - start) / 1000) + "<small>s</small>");
  }, 250);
}

function stopTimer() {
  clearInterval(timer);
}

// click to choose files
function hookPicker(button, inputId, onFiles) {
  const input = document.getElementById(inputId);
  input.onchange = () => {
    if (input.files.length) onFiles([...input.files]);
    input.value = "";
  };
  button.addEventListener("click", () => input.click());
}

// drag files in
function hookDrop(zone, onFiles) {
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("over");
    onFiles([...event.dataTransfer.files]);
  });
}

// screen: start
function renderStart() {
  show("tpl-start", null);
  const drop = document.getElementById("drop");
  hookPicker(drop, "pick-one", (files) => runUpload(files[0]));
  hookDrop(drop, (files) => runUpload(files[0]));
  showExamples();
}

function showExamples() {
  const box = document.getElementById("examples");
  if (!box) return;
  const singles = state.examples.filter((example) => example.mode !== "profile");
  if (state.examplesError) box.innerHTML = `<p class="notice" role="alert">${esc(state.examplesError)}</p>`;
  if (!singles.length) return;
  box.innerHTML = `<ul class="examples">${singles.map(exampleCard).join("")}</ul>`;
  box.querySelectorAll("[data-example]").forEach((button) => {
    button.addEventListener("click", () => runExample(button.dataset.example));
  });
}

function exampleCard(example) {
  return `<li><button type="button" class="example" data-example="${esc(example.id)}">
    <img src="${exampleUrl(example.id)}" alt="" loading="lazy">
    <span>${esc(example.title)}</span>
  </button></li>`;
}

// screen: waiting
function renderWait(title, detail, left, plan) {
  show("tpl-wait", state.mode === "single" ? "attack" : null);
  fill("wait-title", esc(title));
  fill("wait-detail", esc(detail));
  fill("wait-left", left);
  fill("plan", plan.map((step) => `<li>${esc(step)}</li>`).join(""));
  say(title);
  startTimer();
}

function preview(src, alt) {
  return `<figure class="preview"><img src="${src}" alt="${esc(alt)}"><span class="scan" aria-hidden="true"></span></figure>`;
}

function renderError(message) {
  show("tpl-error", null);
  fill("error-text", esc(message));
  document.getElementById("back").addEventListener("click", () => setMode(state.mode));
}

// attack
async function runAttack(request, left) {
  const plan = ["Read the file's metadata", "GeoCLIP guesses the location from pixels", "Find readable text and faces", "Map what gave it away"];
  renderWait("Attacking this photo", "An open AI model and two detectors scan the pixels. This takes a few seconds.", left, plan);
  try {
    state.attack = await request;
    renderAttack();
  } catch (error) {
    renderError(error.message);
  }
}

function runExample(id) {
  state.example = state.examples.find((example) => example.id === id) || null;
  const title = state.example ? state.example.title : "Example photo";
  return runAttack(postForm("attack_example/" + encodeURIComponent(id), {}), preview(exampleUrl(id), title));
}

function runUpload(file) {
  state.example = null;
  if (!file || !isImage(file)) return renderError("That file isn't a photo. Choose a JPEG, PNG or HEIC image.");
  const left = isHeic(file.name) ? "" : preview(URL.createObjectURL(file), "Your photo");
  return runAttack(postForm("attack", { image: file }), left);
}

// numbered clue boxes
function clueList(attack) {
  return [
    ...attack.text.map((item) => ({ box: item.box, label: item.text, kind: "text" })),
    ...attack.faces.map((item) => ({ box: item.box, label: "Face", kind: "face" })),
  ];
}

function clueMark(clue, index, attack) {
  const [left, top, right, bottom] = clue.box;
  const x = (left / attack.width) * 100;
  const y = (top / attack.height) * 100;
  const w = ((right - left) / attack.width) * 100;
  const h = ((bottom - top) / attack.height) * 100;
  const flip = x > 55 ? " flip" : "";
  return `<div class="mark ${clue.kind}${flip}" style="left:${x}%;top:${y}%;width:${w}%;height:${h}%">
    <span class="tag"><b>${index + 1}</b><span class="t">${esc(clue.label.slice(0, 24))}</span></span>
  </div>`;
}

function overlaps(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

// tags above or below their box, never overlapping
function placeTags() {
  const shot = document.getElementById("shot");
  if (!shot) return;
  const frame = shot.getBoundingClientRect();
  const placed = [];
  const marks = [...shot.querySelectorAll(".mark")].sort((a, b) => a.offsetTop - b.offsetTop);
  marks.forEach((mark) => {
    const tag = mark.querySelector(".tag");
    for (const spot of ["above", "below", "inside"]) {
      mark.dataset.spot = spot;
      const box = tag.getBoundingClientRect();
      const fits = box.top >= frame.top && box.bottom <= frame.bottom && box.left >= frame.left && box.right <= frame.right;
      if (spot === "inside" || (fits && !placed.some((other) => overlaps(box, other)))) {
        placed.push(box);
        break;
      }
    }
  });
}

function photoAlt() {
  return state.example ? "Example photo: " + state.example.title : "Your uploaded photo";
}

function showCredit() {
  fill("credit", state.example ? esc(state.example.credit) : "");
}

function niceDate(taken) {
  return taken.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3").slice(0, 16);
}

function gpsDetails(meta, place) {
  const details = [
    place && "GPS points to " + place,
    meta.camera && "Camera: " + meta.camera,
    meta.taken && "Taken " + niceDate(meta.taken),
    meta.other.length && plural(meta.other.length, "more identifying field"),
  ].filter(Boolean);
  return details.map(esc).join(`<span class="sep">/</span>`);
}

function findingsList(attack) {
  const items = clueList(attack).map((clue, index) => {
    const words = clue.kind === "text" ? `<span class="words">${esc(clue.label)}</span>` : "";
    return `<li><b class="n">${index + 1}</b><span>${clue.kind === "text" ? "Readable text" : "Face"}${words}</span></li>`;
  });
  attack.ambient.forEach((clue) => {
    items.push(`<li><b class="n scene" aria-hidden="true"></b><span>Looks like ${esc(clueText(clue))}</span></li>`);
  });
  if (!items.length) return `<p class="muted">No readable text, faces or standout scenery. GeoCLIP read the scene as a whole.</p>`;
  return `<ol class="clues">${items.join("")}</ol>`;
}

// screen: attack
function renderAttack() {
  show("tpl-attack", "attack");
  const attack = state.attack;
  const gps = attack.metadata.gps;
  const off = errorKm(attack);
  const count = attack.text.length + attack.faces.length + attack.ambient.length;
  let headline = `An attacker's AI placed this photo within ${kmHot(attack.location.radius_km, true)}.`;
  if (off != null) headline = `An attacker's AI placed this photo ${kmHot(off)} from where it was taken.`;
  if (off != null && gps) headline = `Even without the GPS, an attacker's AI placed it ${kmHot(off)} from the real spot.`;
  let sub = count ? `It used <span class="hot mono">${count}</span> visual clues in the picture itself. No GPS or metadata.` : "It used only the pixels. No GPS or metadata.";
  if (gps) sub = "GeoCLIP looked only at the pixels, not the metadata.";

  app.querySelector(".attack").style.setProperty("--ar", attack.width / attack.height);
  const photo = document.getElementById("photo");
  photo.src = photoUrl(attack.id);
  photo.alt = photoAlt();
  fill("marks", clueList(attack).map((clue, index) => clueMark(clue, index, attack)).join(""));
  placeTags();
  document.fonts.ready.then(placeTags);
  showCredit();
  document.getElementById("gps").hidden = !gps;
  if (gps) fill("gps-details", gpsDetails(attack.metadata, null));
  fill("headline", headline);
  fill("sub", sub);
  fill("findings", findingsList(attack));
  fill("geoclip", off != null ? `${bigKm(off)}<small>km off</small>` : `~${bigKm(attack.location.radius_km)}<small>km area</small>`);
  fill("score", `${attack.score}<small>/100 ${scoreWord(attack.score)}</small>`);
  document.getElementById("heat").addEventListener("click", toggleHeat);
  document.getElementById("protect").addEventListener("click", protectPhoto);
  say("Attack finished. " + document.getElementById("headline").textContent);

  const pin = gps ? { ...gps, label: "GPS: exact" } : null;
  const area = { ...attack.location, strong: true, label: `~${km(attack.location.radius_km)} km${gps ? " AI guess" : ""}` };
  const viewKm = Math.max(windowKm(attack.location.radius_km), gps ? distanceKm(gps, attack.location) * 1.4 : 0);
  showMap(attack.location, [area], { pin, viewKm }).then(() => {
    if (gps) fill("gps-details", gpsDetails(attack.metadata, regionName([gps.lon, gps.lat], 1)));
  });
}

function toggleHeat() {
  const button = document.getElementById("heat");
  const on = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", on);
  document.getElementById("photo").src = on ? "data:image/png;base64," + state.attack.heatmap_png : photoUrl(state.attack.id);
  document.getElementById("marks").hidden = on;
  document.getElementById("heat-note").hidden = !on;
}

// protect
async function protectPhoto() {
  const attack = state.attack;
  const options = {
    blur_text: document.getElementById("opt-text").checked,
    blur_faces: document.getElementById("opt-faces").checked,
    cloak: document.getElementById("opt-cloak").checked,
  };
  state.options = options;
  const plan = [
    options.blur_text && attack.text.length && "Blur " + plural(attack.text.length, "readable text area"),
    options.blur_faces && attack.faces.length && "Blur " + plural(attack.faces.length, "face"),
    options.cloak && "Nudge pixels by at most 4/255 until GeoCLIP guesses wrong",
    "Save a clean JPEG with no metadata",
    "Attack the saved file again to check",
  ].filter(Boolean);
  const title = options.cloak ? "Computing invisible cloak, about 30 seconds" : "Protecting your photo";
  renderWait(title, "Everything runs on this laptop.", preview(photoUrl(attack.id), photoAlt()), plan);
  setStep("protected");
  try {
    state.protect = await postForm("protect", { id: attack.id, ...options });
    renderProtected();
  } catch (error) {
    renderError(error.message);
  }
}

// zoomed crop of one clue
function zoomCrop(side, label, src, box, attack) {
  const [left, top, right, bottom] = box;
  const size = Math.min(Math.max(right - left, bottom - top) * 1.3, attack.width, attack.height);
  const x = Math.max(0, Math.min(attack.width - size, (left + right) / 2 - size / 2));
  const y = Math.max(0, Math.min(attack.height - size, (top + bottom) / 2 - size / 2));
  const scale = 200 / size;
  const style = `background-image:url('${src}');background-size:${attack.width * scale}px auto;background-position:${-x * scale}px ${-y * scale}px`;
  return `<div class="zoom ${side}"><span class="cap">${label}</span><div class="crop" style="${style}"></div></div>`;
}

function showWipe(attack, before, after) {
  document.getElementById("before").src = before;
  document.getElementById("after").src = after;
  const target = clueList(attack)[0];
  if (target) {
    const face = target.kind === "face";
    const blurred = face ? state.options.blur_faces : state.options.blur_text;
    const zooms = zoomCrop("l", face ? "Before: face visible" : "Before: readable", before, target.box, attack) +
      zoomCrop("r", blurred ? "After: blurred" : "After", after, target.box, attack);
    fill("zooms", zooms);
  }
  hookWipe(document.getElementById("wipe"));
}

function hookWipe(wipe) {
  let dragging = false;
  const set = (percent) => {
    const value = Math.round(Math.min(98, Math.max(2, percent)));
    wipe.style.setProperty("--pos", value + "%");
    wipe.setAttribute("aria-valuenow", value);
    wipe.setAttribute("aria-valuetext", 100 - value + "% protected photo shown");
  };
  const fromPointer = (event) => {
    const rect = wipe.getBoundingClientRect();
    set(((event.clientX - rect.left) / rect.width) * 100);
  };
  wipe.addEventListener("pointerdown", (event) => {
    dragging = true;
    wipe.setPointerCapture(event.pointerId);
    fromPointer(event);
  });
  wipe.addEventListener("pointermove", (event) => dragging && fromPointer(event));
  wipe.addEventListener("pointerup", () => (dragging = false));
  wipe.addEventListener("pointercancel", () => (dragging = false));
  wipe.addEventListener("keydown", (event) => {
    const now = Number(wipe.getAttribute("aria-valuenow"));
    const keys = { ArrowLeft: now - 5, ArrowRight: now + 5, Home: 0, End: 100 };
    if (!(event.key in keys)) return;
    event.preventDefault();
    set(keys[event.key]);
  });
}

function checklist(attack, protect, options) {
  const items = [protect.after.metadata_found ? ["warn", "Metadata still found in the saved file"] : ["ok", "Metadata stripped and verified"]];
  if (options.blur_text && attack.text.length) items.push(["ok", plural(attack.text.length, "readable clue") + " blurred"]);
  if (options.blur_faces && attack.faces.length) items.push(["ok", plural(attack.faces.length, "face") + " blurred"]);
  if (options.cloak) items.push(["ok", "Invisible cloak applied (max pixel change 4/255, less in smooth areas)"]);
  if (protect.after.text.length) items.push(["warn", "Text is still readable in " + plural(protect.after.text.length, "place")]);
  return items.map(([kind, text]) => `<li class="${kind}">${esc(text)}</li>`).join("");
}

function kmBlock(attack, protect) {
  if (trueSpot(attack)) {
    return `<p class="k">GeoCLIP error, re-attacked after protection</p>
      <div class="row"><span class="lbl">Before</span><span class="num before mono">${bigKm(protect.before.error_km)}<small>km</small></span></div>
      <div class="arrow"><svg width="40" height="44" viewBox="0 0 40 44" aria-hidden="true"><path d="M20 2v38M8 28l12 12 12-12" fill="none" stroke="currentColor" stroke-width="2.4"/></svg></div>
      <div class="row"><span class="lbl">After</span><span class="num after mono">${bigKm(protect.after.error_km)}<small>km</small></span></div>`;
  }
  return `<p class="k">GeoCLIP's guess moved, re-attacked after protection</p>
    <div class="row"><span class="num after mono">${bigKm(protect.after.error_km)}<small>km</small></span></div>
    <p class="muted">Without GPS, Unmapped can't know the true spot, so it measures how far the guess moved.</p>`;
}

function honestText(attack, options, moved) {
  const leftovers = attack.ambient.map(clueText).join(", ") || "the areas the heatmap marks";
  let cloak = "";
  if (options.cloak) cloak = moved ? "The cloak fools GeoCLIP, an open model. " : "The cloak didn't move GeoCLIP's guess far on this photo. ";
  return esc(cloak + `Commercial AI like ChatGPT or Claude can still recognize distinctive places from what's left (for this photo: ${leftovers}). If this place matters, crop it out before posting.`);
}

// screen: protected
function renderProtected() {
  show("tpl-protected", "protected");
  const attack = state.attack;
  const protect = state.protect;
  const options = state.options;
  const moved = options.cloak && protect.after.error_moved_km >= 100;
  let headline = `Clues and metadata are gone. <span class="muted">GeoCLIP can still place this photo nearby.</span>`;
  if (moved) headline = `They look the same to you. <span class="muted">A geolocation model now places it somewhere else entirely.</span>`;
  if (!options.cloak) headline = `Clues and metadata are gone. <span class="muted">The pixels weren't cloaked, so GeoCLIP can still place it.</span>`;

  app.querySelector(".split").style.setProperty("--ar", attack.width / attack.height);
  showWipe(attack, photoUrl(attack.id), "data:image/jpeg;base64," + protect.image_jpeg);
  showCredit();
  fill("headline", headline);
  fill("km-block", kmBlock(attack, protect));
  fill("checks", checklist(attack, protect, options));
  fill("score", `<span class="hot">${protect.score_before}</span><span class="to" aria-label="to">→</span>${protect.score_after}<small>/100</small>`);
  fill("honest", honestText(attack, options, moved));
  document.getElementById("save").href = "protected/" + encodeURIComponent(attack.id) + ".jpg";
  document.getElementById("again").addEventListener("click", () => setMode("single"));
  const claude = document.getElementById("claude-test");
  claude.hidden = !state.claude;
  claude.addEventListener("click", testClaude);
  say("Protection finished. " + document.getElementById("headline").textContent);
}

async function testClaude() {
  const button = document.getElementById("claude-test");
  button.disabled = true;
  fill("claude-out", `<p class="muted">Asking Claude where the original and the protected photo were taken...</p>`);
  const rows = [];
  try {
    for (const which of ["original", "protected"]) {
      const answer = await postForm("claude_check", { id: state.attack.id, which });
      const distance = answer.error_km != null ? `<span class="mono hot">${bigKm(answer.error_km)}<small>km off</small></span>` : "";
      const guess = answer.refused ? "Claude declined to guess" : answer.place;
      rows.push(`<div class="row"><span class="lbl">${which === "original" ? "Original" : "Protected"}</span><span class="guess">${esc(guess)}</span>${distance}</div>`);
    }
    fill("claude-out", `<div class="claude-out"><p class="k">Claude, commercial model</p>${rows.join("")}</div>`);
    button.hidden = true;
    app.querySelector(".result").classList.add("compact");
    document.getElementById("claude-out").scrollIntoView({ block: "nearest" });
    say("Claude check finished.");
  } catch (error) {
    fill("claude-out", `<p class="notice">${esc(error.message)}</p>`);
    button.disabled = false;
  }
}

// screen: profile feed
function renderFeed() {
  show("tpl-feed", null);
  const feed = state.feed;
  fill("posts", feed.length
    ? `<ol class="posts">${feed.map(postRow).join("")}</ol>`
    : `<div class="empty"><p>No photos yet. Drop them here.</p><p class="muted">Or load the example feed: 8 public photos around Huntington Beach, posted by a fictional teen.</p></div>`);
  fill("feed-count", `${feed.length} of 10 photos${feed.length < 5 ? ", add at least 5" : ""}`);
  document.getElementById("run-profile").disabled = feed.length < 5;
  hookPicker(document.getElementById("add"), "pick-many", addFeedFiles);
  hookDrop(document.getElementById("feed-drop"), addFeedFiles);
  document.getElementById("example-feed").addEventListener("click", loadExampleFeed);
  document.getElementById("run-profile").addEventListener("click", runProfile);
  app.querySelectorAll("[data-caption]").forEach((input) => {
    input.addEventListener("input", () => (feed[input.dataset.caption].caption = input.value));
  });
  app.querySelectorAll("[data-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      feed.splice(Number(button.dataset.remove), 1);
      renderFeed();
    });
  });
}

function thumb(post) {
  return isHeic(post.name) ? `<span class="heic">HEIC</span>` : `<img src="${post.url}" alt="">`;
}

function postRow(post, index) {
  return `<li class="post">
    ${thumb(post)}
    <label><span class="sr">Caption for photo ${index + 1}</span>
      <input type="text" data-caption="${index}" value="${esc(post.caption)}" placeholder="Caption (optional)"></label>
    <button type="button" class="remove" data-remove="${index}" aria-label="Remove photo ${index + 1}">
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15" stroke="currentColor" stroke-width="1.8"/></svg>
    </button>
  </li>`;
}

function addFeedFiles(files) {
  files.filter(isImage).forEach((file) => {
    if (state.feed.length < 10) state.feed.push({ blob: file, name: file.name, caption: "", url: URL.createObjectURL(file) });
  });
  renderFeed();
}

async function loadExampleFeed() {
  const picks = state.examples.filter((example) => example.mode === "profile").slice(0, 10);
  if (!picks.length) return renderError(state.examplesError || "The server has no example feed.");
  try {
    state.feed = await Promise.all(picks.map(async (example) => {
      const blob = await (await api(exampleUrl(example.id))).blob();
      return { blob, name: example.id + ".jpg", caption: example.caption || "", url: URL.createObjectURL(blob) };
    }));
    renderFeed();
  } catch (error) {
    renderError(error.message);
  }
}

async function runProfile() {
  // one image and caption per photo
  const form = new FormData();
  state.feed.forEach((post) => {
    form.append("images", post.blob, post.name);
    form.append("captions", post.caption);
  });
  const left = `<div class="thumbs">${state.feed.map(thumb).join("")}</div>`;
  const plan = ["GeoCLIP guesses each photo on its own", "Multiply the guesses together", "Scan captions for school, team, home and routine"];
  renderWait("Attacking the whole feed", "About a second per photo.", left, plan);
  try {
    state.profile = await getJson("profile", { method: "POST", body: form });
    renderProfile();
  } catch (error) {
    renderError(error.message);
  }
}

function highlight(caption, flags) {
  let html = esc(caption);
  new Set(flags.map((flag) => esc(flag.match))).forEach((word) => {
    html = html.split(word).join(`<mark>${word}</mark>`);
  });
  return html;
}

function resultRow(post, photo, scan) {
  const kinds = [...new Set(scan.flags.map((flag) => flag.kind))];
  return `<li class="post done">
    ${thumb(post)}
    <div>
      <p>${post.caption.trim() ? highlight(post.caption, scan.flags) : `<span class="muted">No caption</span>`}</p>
      ${kinds.length ? `<p class="kinds">${kinds.map((kind) => `<span>${esc(kind)}</span>`).join("")}</p>` : ""}
    </div>
    <p class="radius nowrap"><span class="mono">~${km(photo.location.radius_km)}</span> km</p>
  </li>`;
}

// screen: profile result
function renderProfile() {
  show("tpl-profile", null);
  const profile = state.profile;
  const radii = profile.photos.map((photo) => photo.location.radius_km);
  const alone = median(radii);
  const together = profile.combined.radius_km;
  const flagCount = profile.captions.reduce((total, item) => total + item.flags.length, 0);
  // server scans only non-empty captions, in order
  let next = 0;
  const rows = state.feed.map((post, index) => {
    const scan = post.caption.trim() ? profile.captions[next++] : null;
    return resultRow(post, profile.photos[index], scan || { flags: [] });
  });
  fill("story", `${profile.photos.length} photos: <span class="mono">~${km(alone)}</span> km each, <span class="mono hot">~${km(together)}</span> km together.`);
  fill("alone", `~${bigKm(alone)}<small>km</small>`);
  fill("together", `~${bigKm(together)}<small>km</small>`);
  fill("score", `${profile.score}<small>/100 ${scoreWord(profile.score)}</small>`);
  fill("flagged", `<span class="mono hot">${flagCount}</span> caption ${flagCount === 1 ? "clue" : "clues"} flagged`);
  fill("results", rows.join(""));
  document.getElementById("edit").addEventListener("click", renderFeed);
  say(`Profile finished. Each photo alone about ${km(alone)} km, together about ${km(together)} km.`);

  const circles = profile.photos.map((photo) => photo.location);
  circles.push({ ...profile.combined, strong: true, label: `~${km(together)} km together` });
  showMap(profile.combined, circles, { startKm: Math.max(...radii) * 1.2, viewKm: alone * 1.3 });
}

// offline map
const mapFiles = {};
const geo = {};

function loadFile(name) {
  if (!mapFiles[name]) mapFiles[name] = getJson("vendor/" + name);
  return mapFiles[name];
}

async function loadGeo() {
  if (geo.countries) return;
  const [world, us, counties] = await Promise.all(["countries-50m.json", "states-10m.json", "counties-10m.json"].map(loadFile));
  geo.countries = topojson.feature(world, world.objects.countries).features;
  geo.borders = topojson.mesh(world, world.objects.countries, (a, b) => a !== b);
  geo.coast = topojson.mesh(world, world.objects.countries, (a, b) => a === b);
  geo.states = topojson.feature(us, us.objects.states).features;
  geo.stateLines = topojson.mesh(us, us.objects.states, (a, b) => a !== b);
  geo.counties = topojson.feature(counties, counties.objects.counties).features;
  geo.countyLines = topojson.mesh(counties, counties.objects.counties, (a, b) => a !== b);
}

function regionName(point, radius) {
  const inside = (features) => features.find((feature) => d3.geoContains(feature, point));
  const usState = inside(geo.states);
  if (usState && radius <= 25) {
    const county = inside(geo.counties);
    if (county) return county.properties.name + " County, " + usState.properties.name;
  }
  if (usState && radius <= 500) return usState.properties.name;
  const country = inside(geo.countries);
  return country ? country.properties.name : "Open water";
}

// km from center to map edge
function windowKm(radius) {
  return Math.max(radius * 1.8, 2.5);
}

async function showMap(center, circles, view) {
  const box = document.getElementById("map-box");
  box.replaceChildren(document.getElementById("tpl-map").content.cloneNode(true));
  const svg = box.querySelector(".world");
  const cap = box.querySelector(".map-cap");
  svg.setAttribute("aria-label", "Map with the guessed area shown as a circle, not a pin");
  try {
    await loadGeo();
  } catch (error) {
    cap.innerHTML = `<p class="k">Map files missing from frontend/vendor</p>`;
    return;
  }
  cap.innerHTML = `<p class="k">Predicted area</p>
    <p class="place">${esc(regionName([center.lon, center.lat], center.radius_km))}</p>
    <p class="rad">within ${kmHot(center.radius_km, true)}</p>
    <p class="k">Shown as an area, not a pin.</p>`;
  const layers = [
    { shape: { type: "Sphere" }, cls: "ocean" },
    { shape: { type: "FeatureCollection", features: geo.countries }, cls: "land" },
    { shape: geo.countyLines, cls: "county", maxKm: 400 },
    { shape: geo.stateLines, cls: "state", maxKm: 5000 },
    { shape: geo.borders, cls: "border" },
    { shape: geo.coast, cls: "coast" },
    ...circles.map((circle) => ({
      shape: d3.geoCircle().center([circle.lon, circle.lat]).radius(circle.radius_km / 111.2)(),
      cls: circle.strong ? "area" : "area faint",
    })),
  ];
  const strong = circles.find((circle) => circle.strong);
  animateMap(svg, mapArea(svg, cap), layers, strong, view);
}

// free space right of the caption
function mapArea(svg, cap) {
  const width = svg.clientWidth;
  const height = svg.clientHeight;
  const left = getComputedStyle(cap).position === "absolute" ? cap.offsetLeft + cap.offsetWidth : 0;
  return { width, height, cx: (left + width) / 2, cy: height / 2, half: Math.min((width - left) / 2, height / 2) - 12 };
}

// globe zoomed so viewKm reaches the edge
function projectionFor(center, area, viewKm) {
  // km from center to edge, as an angle on Earth
  const angle = Math.min(viewKm / 6371, Math.PI / 2);
  return d3.geoOrthographic()
    .rotate([-center.lon, -center.lat])
    .translate([area.cx, area.cy])
    .scale(area.half / Math.sin(angle))
    .clipAngle(90);
}

function animateMap(svg, area, layers, strong, view) {
  svg.setAttribute("viewBox", `0 0 ${area.width} ${area.height}`);
  const map = d3.select(svg);
  const paths = map.selectAll("path").data(layers).join("path").attr("class", (layer) => layer.cls);
  const pin = view.pin && map.append("g").attr("class", "gps-pin");
  if (pin) {
    pin.append("path").attr("d", "M-16 0H16M0-16V16");
    pin.append("circle").attr("r", 7);
    pin.append("text").attr("class", "map-label pin-label").attr("y", -24).text(view.pin.label);
  }
  const label = map.append("text").attr("class", "map-label").text(strong.label);
  const draw = (viewKm) => {
    const projection = projectionFor(strong, area, viewKm);
    const path = d3.geoPath(projection);
    paths.attr("d", (layer) => (viewKm <= (layer.maxKm || Infinity) ? path(layer.shape) : null));
    const south = projection([strong.lon, strong.lat - strong.radius_km / 111.2]);
    label.attr("x", area.cx).attr("y", Math.min(area.height - 16, south[1] + 34));
    if (pin) pin.attr("transform", `translate(${projection([view.pin.lon, view.pin.lat])})`);
  };
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || !view.startKm || view.startKm <= view.viewKm) return draw(view.viewKm);
  // hold wide, then zoom in
  draw(view.startKm);
  setTimeout(() => {
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 2000);
      draw(view.startKm * Math.pow(view.viewKm / view.startKm, d3.easeCubicInOut(t)));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, 1200);
}

// start up
async function init() {
  fitStage();
  window.addEventListener("resize", fitStage);
  setTheme(savedTheme());
  document.getElementById("theme").addEventListener("click", () => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
  document.getElementById("tab-single").addEventListener("click", () => setMode("single"));
  document.getElementById("tab-profile").addEventListener("click", () => setMode("profile"));
  renderStart();
  try { state.examples = await getJson("examples"); } catch (error) { state.examplesError = error.message; }
  try { state.claude = (await getJson("config")).claude === true; } catch (error) { state.claude = false; }
  showExamples();
}

init();
