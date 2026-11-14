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
  feed: [], // uploaded profile photos
  posts: [], // photos in the profile result
  profile: null, // profile result
};
let timer = null;
let geo = null;

// small helpers
function esc(text) { return String(text).replace(/[&<>"']/g, (char) => "&#" + char.charCodeAt(0) + ";"); }

function km(value) {
  if (value < 10) return value.toFixed(1).replace(/\.0$/, "");
  return Math.round(value).toLocaleString("en-US");
}

// tight commas in big mono numbers
function bigKm(value) { return km(value).replace(/[.,]/g, `<span class="c">$&</span>`); }
function kmHot(value, approx) { return `<span class="hot nowrap"><span class="mono">${approx ? "~" : ""}${bigKm(value)}</span> km</span>`; }
function plural(count, word) { return count + " " + word + (count === 1 ? "" : "s"); }

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clueText(clue) { return clue.clue.replace(/^looks like (a |an )?/i, ""); }
function isHeic(name) { return /\.(heic|heif)$/i.test(name); }
function isImage(file) { return /^image\//.test(file.type) || isHeic(file.name); }
function photoUrl(id) { return "photo/" + encodeURIComponent(id) + ".jpg"; }
function exampleUrl(id) { return "example_image/" + encodeURIComponent(id) + ".jpg"; }
function fill(id, html) { document.getElementById(id).innerHTML = html; }
function say(text) { document.getElementById("say").textContent = text; }
function distanceKm(a, b) { return d3.geoDistance([a.lon, a.lat], [b.lon, b.lat]) * 6371; }

function scoreWord(score) {
  if (score < 40) return "exposed";
  if (score < 75) return "at risk";
  return "safer";
}

// server calls
async function getJson(path, options) {
  let response;
  try {
    response = await fetch(path, options);
  } catch (error) {
    throw new Error("Can't reach the Unmapped server. Start it on this laptop, then reload the page.");
  }
  const body = await response.json().catch(() => ({}));
  if (response.ok) return body;
  throw new Error(typeof body.detail === "string" ? body.detail : "The server returned error " + response.status + ".");
}

function postForm(path, fields) {
  const form = new FormData();
  Object.entries(fields).forEach(([key, value]) => form.append(key, value));
  return getJson(path, { method: "POST", body: form });
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.getElementById("theme").setAttribute("aria-label", "Switch to " + (theme === "dark" ? "light" : "dark") + " theme");
  try { localStorage.setItem("theme", theme); } catch (error) {}
}

// scale the 1920x1080 layout to any projector
function fitStage() {
  const zoom = innerWidth >= 1000 ? Math.min(innerWidth / 1920, innerHeight / 1080) : 1;
  document.body.style.zoom = zoom;
  document.documentElement.style.setProperty("--stage-w", innerWidth / zoom + "px");
  document.documentElement.style.setProperty("--stage-h", innerHeight / zoom + "px");
}

function setMode(mode) {
  state.mode = mode;
  document.getElementById("tab-single").setAttribute("aria-pressed", mode === "single");
  document.getElementById("tab-profile").setAttribute("aria-pressed", mode === "profile");
  if (mode === "single") renderStart();
  else renderFeed();
}

// swap in a screen
function show(templateId, step) {
  clearInterval(timer);
  document.getElementById("steps").hidden = !step;
  document.getElementById("step-attack").classList.toggle("on", step === "attack");
  document.getElementById("step-protected").classList.toggle("on", step === "protected");
  app.replaceChildren(document.getElementById(templateId).content.cloneNode(true));
  app.querySelector("h1").focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

// click or drag to add files
function hookFiles(button, zone, inputId, onFiles) {
  const input = document.getElementById(inputId);
  input.onchange = () => {
    if (input.files.length) onFiles([...input.files]);
    input.value = "";
  };
  button.addEventListener("click", () => input.click());
  zone.addEventListener("dragover", (event) => { event.preventDefault(); zone.classList.add("over"); });
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
  hookFiles(drop, drop, "pick-one", (files) => runUpload(files[0]));
  showExamples();
}

function showExamples() {
  const box = document.getElementById("examples");
  if (!box) return;
  const singles = state.examples.filter((example) => example.mode !== "profile");
  if (state.examplesError) box.innerHTML = `<p class="notice" role="alert">${esc(state.examplesError)}</p>`;
  if (!singles.length) return;
  box.innerHTML = `<ul class="examples">${singles.map((example) => `<li>
    <button type="button" class="example" data-example="${esc(example.id)}">
      <img src="${exampleUrl(example.id)}" alt="" loading="lazy"><span>${esc(example.title)}</span>
    </button></li>`).join("")}</ul>`;
  box.querySelectorAll("[data-example]").forEach((button) => button.addEventListener("click", () => runExample(button.dataset.example)));
}

// screen: waiting
function renderWait(title, detail, left, plan, step) {
  show("tpl-wait", step);
  fill("wait-title", esc(title));
  fill("wait-detail", esc(detail));
  fill("wait-left", left);
  fill("plan", plan.map((item) => `<li>${esc(item)}</li>`).join(""));
  say(title);
  const start = Date.now();
  timer = setInterval(() => fill("elapsed", Math.floor((Date.now() - start) / 1000) + "<small>s</small>"), 250);
}

function preview(src, alt) { return `<figure class="preview"><img src="${src}" alt="${esc(alt)}"><span class="scan" aria-hidden="true"></span></figure>`; }

function renderError(message) {
  show("tpl-error", null);
  fill("error-text", esc(message));
  document.getElementById("back").addEventListener("click", () => setMode(state.mode));
}

// attack
function runAttack(request, left) {
  const plan = ["Read the file's metadata", "GeoCLIP guesses the location from pixels", "Find readable text and faces", "Map what gave it away"];
  renderWait("Attacking this photo", "An open AI model and two detectors scan the pixels. This takes a few seconds.", left, plan, "attack");
  return request.then((result) => { state.attack = result; renderAttack(); }).catch((error) => renderError(error.message));
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
    ...attack.text.map((item) => ({ box: item.box, label: item.text.replace(/^\W+/, ""), kind: "text" })),
    ...attack.faces.map((item) => ({ box: item.box, label: "Face", kind: "face" })),
  ];
}

function clueMark(clue, index, attack) {
  const [left, top, right, bottom] = clue.box;
  const x = (left / attack.width) * 100;
  const y = (top / attack.height) * 100;
  const w = ((right - left) / attack.width) * 100;
  const h = ((bottom - top) / attack.height) * 100;
  return `<div class="mark ${clue.kind}${x > 55 ? " flip" : ""}" style="left:${x}%;top:${y}%;width:${w}%;height:${h}%">
    <span class="tag"><b>${index + 1}</b><span class="t">${esc(clue.label.slice(0, 24))}</span></span>
  </div>`;
}

function overlaps(a, b) { return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; }

// tags never sit on top of each other
function placeTags() {
  const shot = document.getElementById("shot");
  if (!shot) return;
  const frame = shot.getBoundingClientRect();
  const placed = [];
  // spots to try
  const tries = [0, 1, 2, 3].flatMap((step) => [["above", -step], ["below", step]]).concat([["inside", 0]]);
  const marks = [...shot.querySelectorAll(".mark")].sort((a, b) => a.offsetTop - b.offsetTop);
  marks.forEach((mark) => {
    const tag = mark.querySelector(".tag");
    tag.hidden = false;
    const fits = tries.some(([spot, step]) => {
      mark.dataset.spot = spot;
      tag.style.translate = `0 ${step * 110}%`;
      const box = tag.getBoundingClientRect();
      const inFrame = box.top >= frame.top && box.bottom <= frame.bottom && box.left >= frame.left && box.right <= frame.right;
      const hitsBox = marks.some((other) => other !== mark && overlaps(box, other.getBoundingClientRect()));
      if (!inFrame || hitsBox || placed.some((other) => overlaps(box, other))) return false;
      placed.push(box);
      return true;
    });
    // no spot: hide tag
    tag.hidden = !fits;
  });
}

function photoAlt() { return state.example ? "Example photo: " + state.example.title : "Your uploaded photo"; }

function gpsDetails(meta, place) {
  const details = [
    place && "GPS points to " + place,
    meta.camera && "Camera: " + meta.camera,
    meta.taken && "Taken " + meta.taken.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3").slice(0, 16),
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
  // true distance if known
  const off = attack.error_km ?? (gps ? distanceKm(gps, attack.location) : null);
  const count = attack.text.length + attack.faces.length + attack.ambient.length;
  let headline = `An attacker's AI placed this photo within ${kmHot(attack.location.radius_km, true)}.`;
  if (off != null) headline = `An attacker's AI placed this photo ${kmHot(off)} from where it was taken.`;
  if (off != null && gps) headline = `Even without the GPS, an attacker's AI placed it ${kmHot(off)} from the real spot.`;
  let sub = "It used only the pixels. No GPS or metadata.";
  if (count) sub = `It used <span class="hot mono">${count}</span> visual ${count === 1 ? "clue" : "clues"} in the picture itself. No GPS or metadata.`;
  if (gps) sub = "GeoCLIP looked only at the pixels, not the metadata.";

  app.querySelector(".attack").style.setProperty("--ar", attack.width / attack.height);
  Object.assign(document.getElementById("photo"), { src: photoUrl(attack.id), alt: photoAlt() });
  fill("marks", clueList(attack).map((clue, index) => clueMark(clue, index, attack)).join(""));
  placeTags();
  document.fonts.ready.then(placeTags);
  fill("credit", state.example ? esc(state.example.credit) : "");
  document.getElementById("gps").hidden = !gps;
  fill("headline", headline);
  fill("sub", sub);
  fill("findings", findingsList(attack));
  fill("geoclip", off != null ? `${bigKm(off)}<small>km off</small>` : `~${bigKm(attack.location.radius_km)}<small>km area</small>`);
  fill("score", `${attack.score}<small>/100 ${scoreWord(attack.score)}</small>`);
  document.getElementById("heat").addEventListener("click", toggleHeat);
  document.getElementById("protect").addEventListener("click", protectPhoto);
  say("Attack finished. " + document.getElementById("headline").textContent);

  const area = { ...attack.location, label: `~${km(attack.location.radius_km)} km${gps ? " AI guess" : ""}` };
  const pin = gps ? { ...gps, label: "GPS: exact" } : null;
  const viewKm = Math.max(windowKm(area.radius_km), gps ? distanceKm(gps, area) * 1.4 : 0);
  showMap(area, { pin, viewKm }).then(() => {
    if (gps) fill("gps-details", gpsDetails(attack.metadata, geo && regionName([gps.lon, gps.lat], 1)));
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
function protectPhoto() {
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
  renderWait(title, "Everything runs on this laptop.", preview(photoUrl(attack.id), photoAlt()), plan, "protected");
  return postForm("protect", { id: attack.id, ...options })
    .then((result) => { state.protect = result; renderProtected(); })
    .catch((error) => renderError(error.message));
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
    fill("zooms", zoomCrop("l", face ? "Before: face visible" : "Before: readable", before, target.box, attack) +
      zoomCrop("r", blurred ? "After: blurred" : "After", after, target.box, attack));
  }
  const range = document.getElementById("wipe-range");
  range.addEventListener("input", () => document.getElementById("wipe").style.setProperty("--pos", range.value + "%"));
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
  if (attack.truth || attack.metadata.gps) {
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
  const { attack, protect, options } = state;
  const moved = options.cloak && protect.after.error_moved_km >= 100;
  let headline = `Clues and metadata are gone. <span class="muted">GeoCLIP can still place this photo nearby.</span>`;
  if (moved) headline = `They look the same to you. <span class="muted">A geolocation model now places it somewhere else entirely.</span>`;
  if (!options.cloak) headline = `Clues and metadata are gone. <span class="muted">The pixels weren't cloaked, so GeoCLIP can still place it.</span>`;

  app.querySelector(".split").style.setProperty("--ar", attack.width / attack.height);
  showWipe(attack, photoUrl(attack.id), "data:image/jpeg;base64," + protect.image_jpeg);
  fill("credit", state.example ? esc(state.example.credit) : "");
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

// opt-in: asks Claude about both photos
async function testClaude() {
  const button = document.getElementById("claude-test");
  button.disabled = true;
  fill("claude-out", `<p class="muted">Asking Claude where the original and the protected photo were taken...</p>`);
  try {
    const answers = await Promise.all(["original", "protected"].map((which) => postForm("claude_check", { id: state.attack.id, which })));
    const rows = answers.map((answer, index) => `<div class="row">
      <span class="lbl">${index ? "Protected" : "Original"}</span>
      <span class="guess">${esc(answer.refused ? "Claude declined to guess" : answer.place)}</span>
      ${answer.error_km != null ? `<span class="mono hot">${bigKm(answer.error_km)}<small>km off</small></span>` : ""}
    </div>`);
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
  hookFiles(document.getElementById("add"), document.getElementById("feed-drop"), "pick-many", addFeedFiles);
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

function thumb(post) { return isHeic(post.name) ? `<span class="heic">HEIC</span>` : `<img src="${post.url}" alt="">`; }

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
    if (state.feed.length < 10) state.feed.push({ file, name: file.name, caption: "", url: URL.createObjectURL(file) });
  });
  renderFeed();
}

// example feed
function loadExampleFeed() {
  const picks = state.examples.filter((example) => example.mode === "profile");
  if (!picks.length) return renderError(state.examplesError || "The server has no example feed.");
  state.posts = picks.map((example) => ({ name: example.id + ".jpg", caption: example.caption || "", url: exampleUrl(example.id) }));
  return attackFeed(getJson("profile_example", { method: "POST" }));
}

function runProfile() {
  // one image and caption per photo
  const form = new FormData();
  state.feed.forEach((post) => {
    form.append("images", post.file, post.name);
    form.append("captions", post.caption);
  });
  state.posts = state.feed;
  return attackFeed(getJson("profile", { method: "POST", body: form }));
}

function attackFeed(request) {
  const left = `<div class="thumbs">${state.posts.map(thumb).join("")}</div>`;
  const plan = ["GeoCLIP guesses each photo on its own", "Multiply the guesses together", "Scan captions for school, team, home and routine"];
  renderWait("Attacking the whole feed", "About a second per photo.", left, plan, null);
  return request.then((result) => { state.profile = result; renderProfile(); }).catch((error) => renderError(error.message));
}

function highlight(caption, flags) {
  let html = esc(caption);
  new Set(flags.map((flag) => esc(flag.match))).forEach((word) => (html = html.split(word).join(`<mark>${word}</mark>`)));
  return html;
}

function resultRow(post, photo, captions) {
  const scan = captions.find((item) => item.caption === post.caption) || { flags: [] };
  const kinds = [...new Set(scan.flags.map((flag) => flag.kind))];
  const number = photo.error_km != null ? km(photo.error_km) : "~" + km(photo.location.radius_km);
  const unit = photo.error_km != null ? "km off" : "km";
  return `<li class="post done">
    ${thumb(post)}
    <div>
      <p>${post.caption.trim() ? highlight(post.caption, scan.flags) : `<span class="muted">No caption</span>`}</p>
      ${kinds.length ? `<p class="kinds">${kinds.map((kind) => `<span>${esc(kind)}</span>`).join("")}</p>` : ""}
    </div>
    <p class="radius nowrap"><span class="mono">${number}</span> ${unit}</p>
  </li>`;
}

// screen: profile result
function renderProfile() {
  show("tpl-profile", null);
  const profile = state.profile;
  const photos = profile.photos;
  // true distance or area size
  const known = profile.error_km != null;
  const alone = median(photos.map((photo) => (known ? photo.error_km : photo.location.radius_km)));
  const together = known ? profile.error_km : profile.combined.radius_km;
  const approx = known ? "" : "~";
  const flagCount = profile.captions.reduce((total, item) => total + item.flags.length, 0);
  fill("story", known
    ? `How far GeoCLIP's guess lands from where these ${photos.length} photos were really taken:`
    : `How big an area GeoCLIP narrows these ${photos.length} photos down to:`);
  fill("alone", `~${bigKm(alone)}<small>km</small>`);
  fill("together", `${approx}${bigKm(together)}<small>km</small>`);
  fill("score", `${profile.score}<small>/100 ${scoreWord(profile.score)}</small>`);
  fill("flagged", `<span class="mono hot">${flagCount}</span> caption ${flagCount === 1 ? "clue" : "clues"} flagged`);
  fill("results", state.posts.map((post, index) => resultRow(post, photos[index], profile.captions)).join(""));
  document.getElementById("edit").addEventListener("click", renderFeed);
  say(`Profile finished. Each photo alone about ${km(alone)} km, together ${approx ? "about " : ""}${km(together)} km.`);

  // photo guesses as dots
  const area = { ...profile.combined, label: `~${km(profile.combined.radius_km)} km together` };
  const spread = median(photos.map((photo) => distanceKm(photo.location, area)));
  const pin = known ? { ...profile.truth, label: "Real area" } : null;
  const dots = photos.map((photo) => [photo.location.lon, photo.location.lat]);
  showMap(area, { pin, dots, viewKm: Math.max(windowKm(area.radius_km), spread * 1.3) });
}

// offline map
async function loadGeo() {
  if (geo) return;
  const [world, us, counties] = await Promise.all(["countries-50m.json", "states-10m.json", "counties-10m.json"].map((name) => getJson("vendor/" + name)));
  geo = {
    countries: topojson.feature(world, world.objects.countries).features,
    borders: topojson.mesh(world, world.objects.countries, (a, b) => a !== b),
    coast: topojson.mesh(world, world.objects.countries, (a, b) => a === b),
    states: topojson.feature(us, us.objects.states).features,
    stateLines: topojson.mesh(us, us.objects.states, (a, b) => a !== b),
    counties: topojson.feature(counties, counties.objects.counties).features,
    countyLines: topojson.mesh(counties, counties.objects.counties, (a, b) => a !== b),
  };
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

// map window size
function windowKm(radius) { return Math.max(radius * 1.8, 40); }

async function showMap(area, view) {
  const box = document.getElementById("map-box");
  box.replaceChildren(document.getElementById("tpl-map").content.cloneNode(true));
  const cap = box.querySelector(".map-cap");
  try {
    await loadGeo();
  } catch (error) {
    cap.innerHTML = `<p class="k">Map files missing from frontend/vendor</p>`;
    return;
  }
  cap.innerHTML = `<p class="k">Predicted area</p>
    <p class="place">${esc(regionName([area.lon, area.lat], area.radius_km))}</p>
    <p class="rad">within ${kmHot(area.radius_km, true)}</p>
    <svg class="inset" aria-hidden="true"></svg>
    <p class="k">Shown as an area, not a pin.</p>`;
  drawInset(cap.querySelector(".inset"), [area.lon, area.lat]);
  const layers = [
    { shape: { type: "Sphere" }, cls: "ocean" },
    { shape: { type: "FeatureCollection", features: geo.countries }, cls: "land" },
    { shape: geo.countyLines, cls: "county", maxKm: 400 },
    { shape: geo.stateLines, cls: "state", maxKm: 5000 },
    { shape: geo.borders, cls: "border" },
    { shape: geo.coast, cls: "coast" },
    { shape: d3.geoCircle().center([area.lon, area.lat]).radius(area.radius_km / 111.2)(), cls: "area" },
  ];
  if (view.dots) layers.push({ shape: { type: "MultiPoint", coordinates: view.dots }, cls: "guess" });
  drawMap(box.querySelector(".world"), cap, layers, area, view);
}

// small US or world map with a dot
function drawInset(svg, point) {
  const width = svg.clientWidth;
  const height = svg.clientHeight;
  const edges = [[6, 6], [width - 6, height - 6]];
  let shapes = { type: "FeatureCollection", features: geo.states };
  let projection = d3.geoAlbersUsa().fitExtent(edges, shapes);
  // not in the US: show the world
  if (!projection(point)) {
    shapes = { type: "FeatureCollection", features: geo.countries };
    projection = d3.geoEqualEarth().fitExtent(edges, { type: "Sphere" });
  }
  const [x, y] = projection(point);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = `<path class="land" d="${d3.geoPath(projection)(shapes)}"></path>
    <circle class="ring" cx="${x}" cy="${y}" r="14"></circle>
    <circle class="dot" cx="${x}" cy="${y}" r="6"></circle>`;
}

// zoom globe to fit
function drawMap(svg, cap, layers, area, view) {
  const width = svg.clientWidth;
  const height = svg.clientHeight;
  // free space right of the caption
  const left = getComputedStyle(cap).position === "absolute" ? cap.offsetLeft + cap.offsetWidth : 0;
  const cx = (left + width) / 2;
  const cy = height / 2;
  const half = Math.min((width - left) / 2, cy) - 12;
  const angle = Math.min(view.viewKm / 6371, Math.PI / 2);
  const projection = d3.geoOrthographic().rotate([-area.lon, -area.lat]).translate([cx, cy]).scale(half / Math.sin(angle)).clipAngle(90);
  const path = d3.geoPath(projection).pointRadius(8);
  const shown = layers.filter((layer) => view.viewKm <= (layer.maxKm || Infinity));
  let html = shown.map((layer) => `<path class="${layer.cls}" d="${path(layer.shape) || ""}"></path>`).join("");
  // circle size on screen
  let radius = projection([area.lon, area.lat - area.radius_km / 111.2])[1] - cy;
  // ring so a tiny circle still stands out
  if (radius < 24) {
    radius += 16;
    html += `<circle class="ring" cx="${cx}" cy="${cy}" r="${radius}"></circle>`;
  }
  if (view.pin) {
    const [x, y] = projection([view.pin.lon, view.pin.lat]);
    html += `<g class="gps-pin" transform="translate(${x} ${y})"><path d="M-16 0H16M0-16V16"></path><circle r="7"></circle>
      <text class="map-label pin-label" x="22" y="8">${esc(view.pin.label)}</text></g>`;
  }
  html += `<text class="map-label" x="${cx}" y="${Math.min(height - 16, cy + radius + 34)}">${esc(area.label)}</text>`;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = html;
}

// start up
async function init() {
  fitStage();
  window.addEventListener("resize", fitStage);
  window.addEventListener("resize", placeTags);
  let theme = "dark";
  try { theme = localStorage.getItem("theme") || "dark"; } catch (error) {}
  setTheme(theme);
  document.getElementById("theme").addEventListener("click", () => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
  document.getElementById("tab-single").addEventListener("click", () => setMode("single"));
  document.getElementById("tab-profile").addEventListener("click", () => setMode("profile"));
  renderStart();
  try { state.examples = await getJson("examples"); } catch (error) { state.examplesError = error.message; }
  try { state.claude = (await getJson("config")).claude === true; } catch (error) {}
  showExamples();
}

init();
