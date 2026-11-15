const app = document.getElementById("app");
const state = {
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

// swap in a screen
function show(templateId, tab) {
  clearInterval(timer);
  ["attack", "protect", "profile"].forEach((name) => {
    const button = document.getElementById("tab-" + name);
    button.classList.toggle("on", name === tab);
    if (name === tab) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
  });
  document.getElementById("tab-protect").disabled = !(state.protect && state.attack && state.protect.id === state.attack.id);
  fill("map-credit", "");
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
  show("tpl-start", "attack");
  const drop = document.getElementById("drop");
  hookFiles(drop, drop, "pick-one", (files) => runUpload(files[0]));
  showExamples();
}

// list the example photos
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
function renderWait(title, detail, left, plan, tab) {
  show("tpl-wait", tab);
  fill("wait-title", esc(title));
  fill("wait-detail", esc(detail));
  fill("wait-left", left);
  fill("plan", plan.map((item) => `<li><b>${esc(item)}</b></li>`).join(""));
  say(title);
  const start = Date.now();
  timer = setInterval(() => fill("elapsed", Math.floor((Date.now() - start) / 1000) + "<small>s</small>"), 250);
}

// photo with a scan line
function preview(src, alt) { return `<figure class="preview"><img src="${src}" alt="${esc(alt)}"><span class="scan" aria-hidden="true"></span></figure>`; }

// draw the error screen
function renderError(message) {
  show("tpl-error", null);
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
  const title = state.example ? state.example.title : "Example photo";
  return runAttack(postForm("attack_example/" + encodeURIComponent(id), {}), preview(exampleUrl(id), title));
}

// attack an uploaded photo
function runUpload(file) {
  state.example = null;
  if (!file || !isImage(file)) return renderError("That file isn't a photo. Choose a JPEG, PNG or HEIC image.");
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

// boxes as % of the photo
function boxStyle(box, attack) {
  const [left, top, right, bottom] = box;
  return `left:${(left / attack.width) * 100}%;top:${(top / attack.height) * 100}%;width:${((right - left) / attack.width) * 100}%;height:${((bottom - top) / attack.height) * 100}%`;
}

// do two boxes overlap
function overlaps(a, b) { return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]; }

// numbered tags beside the first 3 boxes
function clueMarks(attack) {
  const clues = clueList(attack);
  const shot = document.getElementById("shot");
  const [w, h, size] = [shot.clientWidth, shot.clientHeight, 34];
  const taken = clues.map(({ box }) => [box[0] * w / attack.width, box[1] * h / attack.height, box[2] * w / attack.width, box[3] * h / attack.height]);
  const tags = taken.slice(0, 3).map(([left, top, right, bottom], index) => {
    const [cx, cy] = [(left + right - size) / 2, (top + bottom - size) / 2];
    // try each side, near then far
    const spots = [12, 44].flatMap((gap) => [["top", cx, top - gap - size, gap], ["bottom", cx, bottom + gap, gap], ["left", left - gap - size, cy, gap], ["right", right + gap, cy, gap]]);
    const inside = ([, x, y]) => x >= 0 && y >= 0 && x + size <= w && y + size <= h;
    const free = (spot) => inside(spot) && !taken.some((box) => overlaps(box, [spot[1], spot[2], spot[1] + size, spot[2] + size]));
    const [side, x, y, gap] = spots.find(free) || spots.find(inside) || spots[1];
    taken.push([x, y, x + size, y + size]);
    return `<b class="tag ${side}" style="left:${(x / w) * 100}%;top:${(y / h) * 100}%;--gap:${gap}px">${index + 1}</b>`;
  });
  return clues.map((clue) => `<div class="mark ${clue.kind}" style="${boxStyle(clue.box, attack)}"></div>`).join("") + tags.join("");
}

// heat as contour rings on the photo
function heatRings(attack) {
  const n = attack.heat.length;
  const k = 8;
  const size = n * k;
  // blow up each cell, then blur
  const values = d3.range(size * size).map((i) => attack.heat[Math.floor(Math.floor(i / size) / k)][Math.floor((i % size) / k)]);
  d3.blur2({ data: values, width: size }, k);
  const peak = d3.max(values);
  if (peak < 0.15) return "";
  // GeoCLIP sees the center square
  const side = Math.min(attack.width, attack.height);
  const toPhoto = d3.geoIdentity().scale(side / size).translate([(attack.width - side) / 2, (attack.height - side) / 2]);
  const rings = d3.contours().size([size, size]).thresholds([0.45, 0.65, 0.85].map((t) => t * peak))(values);
  return rings.map((ring, index) => {
    const d = d3.geoPath(toPhoto)(ring);
    return `<path class="halo" d="${d}"/><path class="ring r${index}" d="${d}"/>`;
  }).join("");
}

// alt text for the photo
function photoAlt() { return state.example ? "Example photo: " + state.example.title : "Your uploaded photo"; }

// gps facts as small labels
function gpsDetails(meta, place) {
  const gps = meta.gps;
  const details = [
    `${Math.abs(gps.lat).toFixed(2)}° ${gps.lat < 0 ? "S" : "N"}, ${Math.abs(gps.lon).toFixed(2)}° ${gps.lon < 0 ? "W" : "E"}` + (place ? ", " + place : ""),
    meta.camera,
    meta.taken && "Taken " + meta.taken.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3").slice(0, 16),
    meta.other.length && plural(meta.other.length, "more identifying field"),
  ].filter(Boolean);
  return details.map((item) => `<span>${esc(item)}</span>`).join("");
}

// list the top clues
function findingsList(attack) {
  const clues = clueList(attack);
  const items = clues.slice(0, 3).map((clue, index) => `<li><b class="n">${index + 1}</b>
    ${clue.kind === "text" ? `<span class="words">${esc(clue.label.slice(0, 26))}</span>` : "<span>A face</span>"}</li>`);
  if (clues.length > 3) items.push(`<li><b class="n more">+</b><span>${plural(clues.length - 3, "more clue")} boxed</span></li>`);
  const scenes = attack.ambient.slice(0, 2).map(clueText).join(" and ");
  if (scenes) items.push(`<li class="wide"><b class="n scene" aria-hidden="true"></b><span>Scene looks like ${esc(scenes)}</span></li>`);
  if (!items.length) return `<p class="fine">No readable text, faces or standout scenery. GeoCLIP read the scene as a whole.</p>`;
  return `<ol class="clues">${items.join("")}</ol>`;
}

// headline for the attack result
function attackHeadline(reach, gps) {
  if (gps) return "Your photo's file says exactly where you took it.";
  if (reach < 30) return "An open AI model worked out where you took this photo.";
  if (reach < 600) return "An open AI model narrowed this photo down to one region.";
  return "An open AI model read the clues, but missed on this one.";
}

// screen: attack
function renderAttack() {
  show("tpl-attack", "attack");
  const attack = state.attack;
  const gps = attack.metadata.gps;
  // true distance if known
  const off = attack.error_km ?? (gps ? distanceKm(gps, attack.location) : null);
  const shown = off ?? attack.location.radius_km;
  const rings = heatRings(attack);

  app.querySelector(".attack").style.setProperty("--ar", attack.width / attack.height);
  Object.assign(document.getElementById("photo"), { src: photoUrl(attack.id), alt: photoAlt() });
  document.getElementById("rings").setAttribute("viewBox", `0 0 ${attack.width} ${attack.height}`);
  fill("rings", rings);
  fill("marks", clueMarks(attack));
  fill("credit", state.example ? creditHtml(state.example.credit) : "");
  // GeoCLIP only sees the center square
  const side = Math.min(attack.width, attack.height);
  const inset = `${((attack.height - side) / 2 / attack.height) * 100}% ${((attack.width - side) / 2 / attack.width) * 100}%`;
  document.getElementById("heat-layer").style.setProperty("--inset", inset);
  document.getElementById("heat-img").src = "data:image/png;base64," + attack.heatmap_png;
  document.getElementById("heat-note").hidden = !rings;
  document.getElementById("gps").hidden = !gps;
  fill("headline", attackHeadline(shown, gps));
  fill("findings", findingsList(attack));
  document.getElementById("heat").addEventListener("click", toggleHeat);
  document.getElementById("protect").addEventListener("click", protectPhoto);
  document.getElementById("new").addEventListener("click", renderStart);
  say("Attack finished. " + document.getElementById("headline").textContent);
  fill("hero-label", gps ? "Without the GPS, AI is off by" : off != null ? "Off by" : "Somewhere within");
  fill("hero-num", kmNum(shown, off != null ? "" : "~"));
  document.getElementById("hero-num").classList.toggle("long", km(shown).length > 4);
  fill("hero-sub", `GeoCLIP, an open model, in ${attack.seconds} s`);
  fill("hero-score", attack.score);
  showAttackMap(attack, gps).then(() => {
    if (gps && geo) fill("gps-details", gpsDetails(attack.metadata, regionName([gps.lon, gps.lat], 25)));
  });
}

// short credit, full link on hover
function creditHtml(credit) {
  const link = credit.match(/\s*\((https?:\/\/\S+)\)/);
  if (!link) return esc(credit);
  const short = credit.replace(link[0], "").replace(" via ", " ");
  return `<a href="${esc(link[1])}" title="${esc(link[1])}" target="_blank" rel="noopener">${esc(short)}</a>`;
}

// heat only inside GeoCLIP's square
function toggleHeat() {
  const button = document.getElementById("heat");
  const on = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", on);
  document.getElementById("heat-layer").hidden = !on;
  // svg needs the attribute
  const rings = document.getElementById("rings");
  rings.toggleAttribute("hidden", on);
  fill("heat-note", on ? "Red: where blurring moved the guess most, inside the square GeoCLIP sees." : "Rings mark where the model looked hardest.");
  document.getElementById("heat-note").hidden = !on && !rings.innerHTML;
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
  const detail = options.cloak ? "About 30 seconds. Everything runs on this laptop." : "Everything runs on this laptop.";
  renderWait(title, detail, preview(photoUrl(attack.id), photoAlt()), plan, "protect");
  return postForm("protect", { id: attack.id, ...options })
    .then((result) => { state.protect = result; renderProtected(); })
    .catch((error) => renderError(error.message));
}

// list what protect changed
function checklist(attack, protect, options) {
  const items = [protect.after.metadata_found
    ? ["warn", "Metadata still found", "in the saved file"]
    : ["ok", "Metadata removed", "checked again after saving"]];
  if (options.blur_text && attack.text.length) items.push(["ok", plural(attack.text.length, "text clue") + " blurred", attack.faces.length && !options.blur_faces ? "faces left as they were" : "readable words hidden"]);
  if (options.blur_faces && attack.faces.length) items.push(["ok", plural(attack.faces.length, "face") + " blurred", "people can't be recognized"]);
  if (options.cloak) items.push(["ok", "Cloak added", "at most 4 of 255 per pixel"]);
  if (protect.after.text.length) items.push(["warn", "Text still readable", "in " + plural(protect.after.text.length, "place")]);
  return items.map(([kind, title, detail]) => `<li class="${kind}"><b>${esc(title)}</b><span>${esc(detail)}</span></li>`).join("");
}

// plain note on what protect can't fix
function honestText(attack, options, moved) {
  const leftovers = attack.ambient.map(clueText).join(", ") || "the buildings and scenery the rings marked";
  let cloak = "";
  if (options.cloak) cloak = moved ? "The cloak fools GeoCLIP, an open model. " : "The cloak didn't move GeoCLIP's guess far on this photo. ";
  else cloak = "The pixels weren't cloaked, so GeoCLIP can still place it. ";
  return esc(cloak + `Commercial AI like ChatGPT or Claude can still recognize distinctive places from what's left: ${leftovers}. If this place matters, crop it out before posting.`);
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
  let headline = "Clues and metadata are gone. GeoCLIP can still place it nearby.";
  if (moved) headline = `Protected. The same model now guesses ${esc(newPlace)}.`;
  if (!options.cloak) headline = "Clues and metadata are gone. The pixels weren't cloaked.";

  fill("headline", headline);
  app.querySelector(".protected").style.setProperty("--ar", attack.width / attack.height);
  document.getElementById("before").src = photoUrl(attack.id);
  document.getElementById("after").src = "data:image/jpeg;base64," + protect.image_jpeg;
  const blurred = [...(options.blur_text ? attack.text : []), ...(options.blur_faces ? attack.faces : [])];
  fill("blurs", blurred.map((item) => `<div class="blurmark" style="${boxStyle(item.box, attack)}"></div>`).join(""));
  fill("checks", checklist(attack, protect, options));
  // the cloak varies a little each run
  fill("p-label", (known ? "Now off by" : "GeoCLIP's guess moved") + (options.cloak ? " about" : ""));
  fill("p-num", kmNum(protect.after.error_km));
  app.querySelector(".p-hero").classList.toggle("moved", moved);
  fill("p-was", known
    ? `<p class="eyebrow">Before</p><p class="was">${kmNum(protect.before.error_km)}</p>`
    : `<p class="fine">Without GPS, Unmapped can't know the true spot, so it measures how far the guess moved.</p>`);
  fill("score", `${protect.score_before}<span class="to">to</span><b>${protect.score_after}</b><span class="of">/ 100</span>`);
  fill("honest", honestText(attack, options, moved));
  document.getElementById("save").href = "protected/" + encodeURIComponent(attack.id) + ".jpg";
  document.getElementById("again").addEventListener("click", renderStart);
  document.getElementById("claude-test").addEventListener("click", testClaude);
  if (!state.claude) fill("claude-out", `<h2 class="eyebrow">Claude test is off</h2><p class="fine">No Anthropic API key on this laptop, so nothing is sent anywhere.</p>`);
  say("Protection finished. " + document.getElementById("headline").textContent);
  showFlightMap(before, after, moved);
}

// one column of Claude's answer
function claudeColumn(label, answer) {
  if (answer.refused) return `<div class="cl-col"><p class="eyebrow">${label}</p><p class="cl-place">Claude declined to guess</p></div>`;
  const number = answer.error_km != null ? `<p class="cl-num">${kmNum(answer.error_km)}<span class="off">off</span></p>` : "";
  return `<div class="cl-col"><p class="eyebrow">${label}</p>${number}<p class="cl-place">${esc(answer.place)}</p></div>`;
}

// opt-in: asks Claude about both photos
async function testClaude() {
  const button = document.getElementById("claude-test");
  button.disabled = true;
  button.textContent = "Asking Claude about both photos...";
  try {
    const answers = await Promise.all(["original", "protected"].map((which) => postForm("claude_check", { id: state.attack.id, which })));
    fill("claude-out", `<h2 class="eyebrow">Claude, a commercial AI, on the same two photos</h2>
      <div class="cl-cols">${claudeColumn("Original", answers[0])}${claudeColumn("Protected", answers[1])}</div>`);
    const still = answers[1].error_km != null && answers[1].error_km < 50;
    if (still) document.getElementById("honest").insertAdjacentHTML("beforeend", " <b>Claude still found it. The cloak is tuned to fool the open model, not every AI.</b>");
    say("Claude check finished.");
  } catch (error) {
    button.disabled = false;
    button.textContent = "Send both photos to Claude";
    document.getElementById("claude-out").insertAdjacentHTML("beforeend", `<p class="notice" role="alert">${esc(error.message)}</p>`);
  }
}

// screen: profile feed
function renderFeed() {
  show("tpl-feed", "profile");
  const feed = state.feed;
  fill("posts", feed.length
    ? `<ol class="posts">${feed.map(postRow).join("")}</ol>`
    : `<div class="empty"><p>No photos yet. Drop them here.</p><p class="fine">Or load the example feed: 8 public photos around Huntington Beach, posted by a fictional teen.</p>
      <div class="sample" aria-hidden="true">${feedExamples().map((example) => `<img src="${exampleUrl(example.id)}" alt="">`).join("")}</div></div>`);
  fill("feed-count", `${feed.length} of 10 photos${feed.length < 5 ? ", add at least 5" : ""}`);
  document.getElementById("run-profile").disabled = feed.length < 5;
  hookFiles(document.getElementById("add"), document.getElementById("feed-drop"), "pick-many", addFeedFiles);
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
  const place = regionName([profile.combined.lon, profile.combined.lat], profile.combined.radius_km).split(",")[0];
  const flagCount = profile.captions.reduce((total, item) => total + item.flags.length, 0);
  fill("headline", profile.combined.radius_km <= 100
    ? `${count} ordinary posts. Together they point to one part of ${esc(place)}.`
    : `${count} ordinary posts. Together they narrow it down to ${esc(place)}.`);
  fill("alone-label", known ? "Each photo alone misses by" : "Each photo alone narrows to");
  fill("together-label", `All ${count.toLowerCase()} together ${known ? "miss by" : "narrow to"}`);
  fill("alone", kmNum(alone, known ? "" : "~"));
  fill("together", kmNum(together, known ? "" : "~"));
  fill("flagged", `<b>${flagCount}</b> ${flagCount === 1 ? "clue" : "clues"} in ${plural(profile.captions.filter((item) => item.caption).length, "caption")}<br><b>${profile.score}</b> / 100 profile score<br>100 = safest`);
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
  const x = d3.scaleLog().domain([1, 20000]).range([30, width - 50]).clamp(true);
  const w = 150, h = 100, gap = 12, top = 34;
  // sort by distance, then push apart
  const order = d3.sort(d3.range(values.length), (i) => values[i]);
  const lefts = [];
  order.forEach((i, k) => (lefts[k] = Math.max(x(values[i]) - w / 2, k ? lefts[k - 1] + w + gap : 0)));
  for (let k = order.length - 1; k >= 0; k--) lefts[k] = Math.min(lefts[k], k < order.length - 1 ? lefts[k + 1] - w - gap : width - w);
  let html = `<line class="axis" x1="${x(1)}" x2="${x(20000)}" y1="${axisY}" y2="${axisY}"/>`;
  x.ticks().forEach((tick) => {
    const major = Number.isInteger(Math.log10(tick));
    html += `<line class="axis${major ? "" : " minor"}" x1="${x(tick)}" x2="${x(tick)}" y1="${axisY + (major ? 8 : 0)}" y2="${axisY - (major ? 14 : 7)}"/>`;
    if (major) html += `<text class="ax-label" x="${x(tick)}" y="${axisY + 40}" text-anchor="middle">${tick.toLocaleString("en-US")} km</text>`;
  });
  order.forEach((i, k) => {
    const post = state.posts[i];
    const left = lefts[k];
    const value = x(values[i]);
    // longer leads bend lower, so they never cross
    const elbow = top + h + 10 + Math.min(34, Math.abs(left + w / 2 - value) / 12);
    html += `<path class="hang" d="M${value} ${axisY}V${elbow}H${left + w / 2}V${top + h}"/><circle class="hang-dot" cx="${value}" cy="${axisY}" r="5"/>
      <text class="thumb-km" x="${left + w / 2}" y="${top - 10}" text-anchor="middle">${known ? "" : "~"}${km(values[i])}</text>
      ${isHeic(post.name) ? `<rect class="heic" x="${left}" y="${top}" width="${w}" height="${h}"/>` : `<image href="${post.url}" x="${left}" y="${top}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/>`}
      <rect class="frame" x="${left}" y="${top}" width="${w}" height="${h}"/>
      <rect class="badge" x="${left}" y="${top}" width="30" height="30"/><text class="badge-n" x="${left + 15}" y="${top + 22}" text-anchor="middle">${i + 1}</text>`;
  });
  html += `<line class="median" x1="${x(alone)}" x2="${x(alone)}" y1="${axisY - 30}" y2="${axisY + 54}"/>
    <text class="ax-note" x="${x(alone) + 10}" y="${axisY + 76}">median alone, ${km(alone)} km</text>
    <line class="comb" x1="${x(together)}" x2="${x(together)}" y1="${axisY - 40}" y2="${axisY + 54}"/>
    <path class="comb" d="M${x(together)} ${axisY - 9}l9 9-9 9-9-9Z"/>
    <text class="ax-note strong" x="${x(together) - 10}" y="${axisY + 76}" text-anchor="end">together, ${km(together)} km</text>`;
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
    box.insertAdjacentHTML("afterbegin", `<p class="notice">Map files are missing from frontend/vendor.</p>`);
    return null;
  }
  if (!box.isConnected) return null;
  box.insertAdjacentHTML("afterbegin", `<svg class="map" role="img" aria-label="Map with the guessed area drawn as a circle, never a pin"></svg>`);
  fill("map-credit", credit);
  return box.querySelector("svg");
}

// coast with engraved water lines
function geoLayers(path, viewKm, ripples) {
  const land = path(geo.land);
  let html = ripples.map((gap) => `<path class="ripple" d="${land}" style="stroke-width:${gap * 2}px"/><path class="ripple-gap" d="${land}" style="stroke-width:${gap * 2 - 1.5}px"/>`).join("");
  html += `<path class="land" d="${land}"/>`;
  if (viewKm < 700) html += `<path class="county" d="${path(geo.countyLines)}"/>`;
  if (viewKm < 5000) html += `<path class="state" d="${path(geo.stateLines)}"/>`;
  return html + `<path class="border" d="${path(geo.borders)}"/>`;
}

// Mercator with a fixed km scale
function mercator(center, pxPerKm, at, clip) {
  const scale = pxPerKm * 6371 * Math.cos((center.lat * Math.PI) / 180);
  return d3.geoMercator().center([center.lon, center.lat]).scale(scale).translate(at).clipExtent(clip);
}

// degrees minutes seconds text
function dms(value, positive, negative) {
  const minutes = Math.round(Math.abs(value) * 60);
  return `${Math.floor(minutes / 60)}°${minutes % 60 ? String(minutes % 60).padStart(2, "0") + "′" : ""}${value < 0 ? negative : positive}`;
}

// lat/lon lines and edge labels
function graticule(projection, width, height, x0 = 0, y0 = 0) {
  const [west, north] = projection.invert([x0, y0]);
  const [east, south] = projection.invert([x0 + width, y0 + height]);
  const step = [1 / 60, 1 / 30, 1 / 12, 1 / 6, 1 / 4, 1 / 2, 1, 2, 5, 10, 15, 30].find((s) => (east - west) / s <= 6) || 30;
  const grid = d3.geoGraticule().step([step, step]).extent([[west - step, south - step], [east + step, north + step]]);
  const ticks = (from, to) => d3.range(Math.ceil(from / step) * step, to, step);
  let labels = "";
  ticks(west, east).forEach((lon) => {
    const x = projection([lon, south])[0];
    if (x > 60 && x < width - 60) labels += `<line class="tick" x1="${x}" x2="${x}" y1="${height - 14}" y2="${height + 10}"/><line class="tick" x1="${x}" x2="${x}" y1="0" y2="14"/><text class="grat-label out" x="${x}" y="${height + 38}" text-anchor="middle">${dms(lon, "E", "W")}</text>`;
  });
  ticks(south, north).forEach((lat) => {
    const y = projection([west, lat])[1];
    if (y > 40 && y < height - 40) labels += `<line class="tick" x1="${width - 14}" x2="${width}" y1="${y}" y2="${y}"/><line class="tick" x1="0" x2="14" y1="${y}" y2="${y}"/><text class="grat-label" x="${width - 22}" y="${y + 8}" text-anchor="end">${dms(lat, "N", "S")}</text>`;
  });
  return { lines: `<path class="grat" d="${pathOf(projection)(grid())}"/>`, labels };
}

// path maker that never returns null
function pathOf(projection) {
  const path = d3.geoPath(projection);
  return (shape) => path(shape) || "";
}

// circle shape around a point
function circle(point, radiusKm) { return d3.geoCircle().center([point.lon, point.lat]).radius(radiusKm / 111.2)(); }

// distance rings around the guess
function distanceRings(path, projection, area, pxPerKm, maxKm, avoid) {
  const kept = [];
  [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].forEach((ring) => {
    const last = kept[kept.length - 1] || area.radius_km;
    if (ring >= area.radius_km * 2 && ring <= maxKm && (ring - last) * pxPerKm >= 46 && kept.length < 3) kept.push(ring);
  });
  // label on a diagonal with no pill nearby
  return kept.map((ring) => {
    const spots = [-135, -45, 135, 45].map((degrees) => {
      const [angle, step] = [(degrees * Math.PI) / 180, ring / 111.2];
      return projection([area.lon + (step * Math.cos(angle)) / Math.cos((area.lat * Math.PI) / 180), area.lat - step * Math.sin(angle)]);
    });
    const [x, y] = spots.find(([sx, sy]) => sx > 50 && avoid.every(([ax, ay]) => Math.hypot(ax - sx, ay - sy) > 70)) || spots[0];
    return `<path class="range" d="${path(circle(area, ring))}"/>${x > 50 ? `<text class="range-label" x="${x}" y="${y + 8}" text-anchor="middle">${km(ring)} km</text>` : ""}`;
  }).join("");
}

// label on the left in the right half
function gpsCross(projection, gps, width) {
  const [x, y] = projection([gps.lon, gps.lat]);
  const left = x > width / 2;
  return `<g class="gps-cross" transform="translate(${x} ${y})"><path class="halo" d="M-18 0H18M0-18V18"/><path d="M-18 0H18M0-18V18"/><circle r="6"/>
    <text class="map-tag" x="${left ? -24 : 24}" y="-12" text-anchor="${left ? "end" : "start"}">GPS in the file</text></g>`;
}

// italic place name and a note
function placeTag(x, y, anchor, title, detail, cls = "") {
  const at = `x="${x}" text-anchor="${anchor}"`;
  return `<text class="place-tag ${cls}" ${at} y="${y}"><tspan class="pt-title">${esc(title)}</tspan><tspan class="pt-sub" ${at} dy="32">${esc(detail)}</tspan></text>`;
}

// tag beside a point, flipped if it would leave the map
function sideTag([x, y], gap, anchor, [width, height], title, detail, cls = "") {
  const size = gap + Math.max(title.length * 16, detail.length * 12);
  if (anchor === "start" && x + size > width) anchor = "end";
  else if (anchor === "end" && x - size < 0) anchor = "start";
  return placeTag(x + (anchor === "end" ? -gap : gap), Math.min(Math.max(y - 4, 40), height - 44), anchor, title, detail, cls);
}

// draw the guess circle
function guessCircle(path, area) {
  const d = path(circle(area, area.radius_km));
  return `<path class="guess-halo" d="${d}"/><path class="guess" d="${d}"/>`;
}

// survey chart around a guess
function chart(svg, area, halfKm, at, ripples, avoid = []) {
  const width = svg.clientWidth;
  const height = svg.clientHeight - 48;
  const pxPerKm = (width * 0.5) / halfKm;
  const projection = mercator(area, pxPerKm, [width * at[0], height * at[1]], [[-40, -40], [width + 40, height + 40]]);
  const path = pathOf(projection);
  const grid = graticule(projection, width, height);
  svg.setAttribute("viewBox", `0 0 ${width} ${svg.clientHeight}`);
  return {
    width, height, pxPerKm, projection, center: projection([area.lon, area.lat]),
    open: `<clipPath id="neat"><rect width="${width}" height="${height}"/></clipPath>
      <g clip-path="url(#neat)"><rect class="sea" width="${width}" height="${height}"/>${grid.lines}${geoLayers(path, halfKm, ripples)}
      ${distanceRings(path, projection, area, pxPerKm, halfKm * 0.9, avoid.map((point) => projection(point)))}${guessCircle(path, area)}`,
    close: `</g><rect class="neat" width="${width}" height="${height}"/>${grid.labels}`,
  };
}

// draw the attack map
async function showAttackMap(attack, gps) {
  const svg = await mapSvg("Mercator. Map data: Natural Earth, US Census Bureau.");
  if (!svg) return;
  const area = attack.location;
  // no county lines abroad, so show more coast
  const abroad = !geo.states.some((usState) => d3.geoContains(usState, [area.lon, area.lat]));
  const halfKm = Math.min(Math.max(area.radius_km * 4, abroad ? 400 : 60, gps ? distanceKm(gps, area) * 1.6 : 0), 6000);
  const loupe = (area.radius_km * svg.clientWidth * 0.5) / halfKm < 16;
  const map = chart(svg, area, halfKm, loupe ? [0.6, 0.74] : [0.36, 0.52], [24, 14, 6]);
  const [cx, cy] = map.center;
  const name = regionName([area.lon, area.lat], area.radius_km).split(",")[0];
  const detail = `the guess, within about ${km(area.radius_km)} km`;
  let html = map.open + (loupe ? `<circle class="guess-sm" cx="${cx}" cy="${cy}" r="10"/>` : "") + (gps ? gpsCross(map.projection, gps, map.width) : "") + map.close;
  // tag beside or below the circle
  html += loupe ? sideTag(map.center, 30, "start", [map.width, map.height], name, detail) : placeTag(cx, cy + area.radius_km * map.pxPerKm + 44, "middle", name, detail);
  if (loupe) html += drawLoupe(area, gps, map.pxPerKm, map.center, [214, map.height - 214]);
  svg.innerHTML = html;
}

// zoomed inset for a tiny circle
function drawLoupe(area, gps, mainPxPerKm, guessAt, center) {
  const radius = 176;
  const pxPerKm = Math.min(66 / area.radius_km, mainPxPerKm * 60);
  const times = Math.round(pxPerKm / mainPxPerKm);
  const [x0, y0] = center;
  const projection = mercator(area, pxPerKm, center, [[x0 - radius - 40, y0 - radius - 40], [x0 + radius + 40, y0 + radius + 40]]);
  const path = pathOf(projection);
  // lines from the guess to the lens edge
  const [px, py] = guessAt;
  const angle = Math.atan2(py - y0, px - x0);
  const spread = Math.acos(radius / Math.hypot(px - x0, py - y0));
  const tangents = [angle - spread, angle + spread].map((a) => `<line class="tangent" x1="${px}" y1="${py}" x2="${x0 + radius * Math.cos(a)}" y2="${y0 + radius * Math.sin(a)}"/>`).join("");
  const bar = [1, 2, 5, 10, 20].find((step) => step * pxPerKm >= 70) || 20;
  const [gx, gy] = projection([area.lon, area.lat]);
  return `${tangents}<clipPath id="lens"><circle cx="${x0}" cy="${y0}" r="${radius}"/></clipPath>
    <circle class="loupe-bezel" cx="${x0}" cy="${y0}" r="${radius + 8}"/>
    <g class="lens" clip-path="url(#lens)"><rect class="sea" x="${x0 - radius}" y="${y0 - radius}" width="${radius * 2}" height="${radius * 2}"/>
      ${geoLayers(path, 1, [12, 6])}${graticule(projection, radius * 2, radius * 2, x0 - radius, y0 - radius).lines}
      ${guessCircle(path, area)}<circle class="guess-dot" cx="${gx}" cy="${gy}" r="5"/>${gps ? gpsCross(projection, gps, x0 * 2) : ""}
      <rect class="sbar-a" x="${x0 - (bar * pxPerKm) / 2}" y="${y0 + radius - 52}" width="${bar * pxPerKm}" height="8"/>
      <text class="sbar-l" x="${x0}" y="${y0 + radius - 62}" text-anchor="middle">${bar} km</text></g>
    <circle class="loupe-edge" cx="${x0}" cy="${y0}" r="${radius}"/>
    <text class="loupe-title" x="${x0 - radius}" y="${y0 - radius - 26}">Enlarged ${times} times</text>`;
}

// whole world, or zoomed in on a short arc
function flightProjection(a, b, mid, size) {
  const reach = Math.max((d3.geoDistance(a, b) * 180) / Math.PI * 0.7, 10);
  const view = reach > 45 ? { type: "Sphere" } : d3.geoCircle().center(mid).radius(reach)();
  return d3.geoEqualEarth().rotate([-mid[0], 0]).fitExtent([[10, 10], [size[0] - 10, size[1] - 10]], view);
}

// world map with the guess flying away
async function showFlightMap(before, after, moved) {
  const svg = await mapSvg("Equal Earth. Map data: Natural Earth.");
  if (!svg) return;
  const size = [svg.clientWidth, svg.clientHeight];
  const a = [before.lon, before.lat];
  const b = [after.lon, after.lat];
  const arc = { type: "LineString", coordinates: d3.range(0, 1.0001, 1 / 64).map(d3.geoInterpolate(a, b)) };
  const projection = flightProjection(a, b, d3.geoInterpolate(a, b)(0.5), size);
  const path = pathOf(projection);
  const [pa, pb] = [projection(a), projection(b)];
  // labels on the outer sides
  const left = pa[0] < pb[0];
  const oldName = regionName(a, before.radius_km > 25 ? before.radius_km : 100);
  const newName = regionName(b, 500);
  svg.setAttribute("viewBox", `0 0 ${size[0]} ${size[1]}`);
  const sphere = path({ type: "Sphere" });
  svg.innerHTML = `<clipPath id="globe"><path d="${sphere}"/></clipPath><path class="sea" d="${sphere}"/>
    <g clip-path="url(#globe)"><path class="grat" d="${path(d3.geoGraticule().step([30, 30])())}"/>${geoLayers(path, 9000, [5])}</g>
    <path class="sphere" d="${sphere}"/>
    ${moved ? `<path class="arc-under" d="${path(arc)}"/><path class="arc" pathLength="1" d="${path(arc)}"/>` : ""}
    <circle class="old-ring" cx="${pa[0]}" cy="${pa[1]}" r="20"/><circle class="old-core" cx="${pa[0]}" cy="${pa[1]}" r="6"/>
    <circle class="new-ring" cx="${pb[0]}" cy="${pb[1]}" r="18"/><circle class="new-core" cx="${pb[0]}" cy="${pb[1]}" r="6"/>
    ${sideTag(pa, 30, left ? "end" : "start", size, oldName, "old guess")}
    ${sideTag(pb, 30, left ? "start" : "end", size, newName, moved ? "where it guesses now" : "new guess", "safe")}`;
}

// regional map with every photo's guess
async function showProfileMap(profile) {
  const svg = await mapSvg("Mercator. Map data: Natural Earth, US Census Bureau.");
  if (!svg) return;
  const area = profile.combined;
  const guesses = profile.photos.map((photo) => [photo.location.lon, photo.location.lat]);
  const map = chart(svg, area, Math.max(area.radius_km * 4, 220), [0.6, 0.62], [20, 12, 5], guesses);
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
    const w = 18 + text.length * 13;
    return `<g class="pmark" transform="translate(${pill.x} ${pill.y})"><rect x="${-w / 2}" y="-17" width="${w}" height="34" rx="17"/><text y="8" text-anchor="middle">${text}</text></g>`;
  }).join("");
  const name = regionName([area.lon, area.lat], area.radius_km).split(",")[0];
  const tag = sideTag(map.center, area.radius_km * map.pxPerKm + 18, "start", [map.width, map.height], name, `all together, within about ${km(area.radius_km)} km`);
  svg.innerHTML = map.open + pillHtml + tag + map.close;
  svg.insertAdjacentHTML("afterend", `<p class="map-note">Pills: each photo's own guess.${offMap ? ` ${offMap} more ${offMap === 1 ? "is" : "are"} off this map.` : ""}</p>`);
}

// start the app
async function init() {
  fitStage();
  window.addEventListener("resize", fitStage);
  let theme = "light";
  try { theme = localStorage.getItem("theme") || "light"; } catch (error) {}
  setTheme(theme);
  document.getElementById("theme").addEventListener("click", () => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
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
