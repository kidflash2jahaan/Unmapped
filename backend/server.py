import base64
import io
import json
import os
import threading
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from PIL import Image

# load models from the local cache, no internet
os.environ["HF_HUB_OFFLINE"] = "1"

import clues
import geo
import metadata
import claude_check
import profiles

ROOT = Path(__file__).parent.parent
EXAMPLES = {example["id"]: example for example in json.load(open(ROOT / "demo" / "examples.json"))}

app = FastAPI()
photos = {}
# one photo at a time on the GPU
gpu = threading.Lock()

# warm up the GPU
clues.heatmap(Image.new("RGB", (224, 224)))

LOCATION_PENALTY = [(1, 30), (5, 25), (25, 20), (100, 12), (500, 5)]


# 100 = private
def privacy_score(has_gps, location_km, texts=0, faces=0, flags=0, cloaked=False):
    score = 100
    if has_gps:
        score -= 50
    # tighter location, bigger penalty
    for limit, penalty in LOCATION_PENALTY:
        if location_km <= limit:
            # the cloak stops open models, not commercial AI
            score -= penalty // 2 if cloaked else penalty
            break
    score -= 5 * min(texts, 4)
    score -= 5 * min(faces, 2)
    score -= 5 * min(flags, 4)
    return max(score, 0)


def error_km(truth, location):
    return round(geo.distance_km(truth["lat"], truth["lon"], location["lat"], location["lon"]), 1)


# how closely the guess pins down the real spot
def reach_km(truth, location):
    return max(location["radius_km"], error_km(truth, location))


def png_base64(image):
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return base64.b64encode(buffer.getvalue()).decode()


def jpeg_response(image):
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=90)
    return Response(buffer.getvalue(), media_type="image/jpeg")


def read_upload(upload):
    data = upload.file.read()
    try:
        info, image = metadata.read_metadata(io.BytesIO(data)), metadata.load_image(io.BytesIO(data))
    except Exception:
        raise HTTPException(400, f"{upload.filename} is not an image we can read")
    if min(image.size) < 64:
        raise HTTPException(400, f"{upload.filename} is too small")
    return info, image


def find_photo(photo_id):
    if photo_id not in photos:
        raise HTTPException(404, "Unknown photo id, run /attack first")
    return photos[photo_id]


def attack(image, info, truth=None):
    start = time.time()
    with gpu:
        location = geo.locate(image)
        text = clues.find_text(image)
        faces = clues.find_faces(image)
        ambient = clues.ambient_clues(image)
        heat = clues.heatmap(image)
    small = image.copy()
    small.thumbnail((1024, 1024))
    picture = clues.overlay(small, heat)
    known = truth is not None or info["gps"] is not None
    if truth is None:
        truth = info["gps"] or {"lat": location["lat"], "lon": location["lon"]}
    photo_id = uuid.uuid4().hex[:12]
    result = {
        "id": photo_id,
        "metadata": info,
        "location": location,
        "text": text,
        "faces": faces,
        "ambient": ambient,
        "heat": heat,
        "heatmap_png": png_base64(picture),
        "score": privacy_score(info["gps"] is not None, reach_km(truth, location), len(text), len(faces)),
        "width": image.width,
        "height": image.height,
        "seconds": round(time.time() - start, 1),
    }
    photos[photo_id] = {"image": image, "attack": result, "truth": truth, "known": known}
    # keep only the 20 newest photos
    if len(photos) > 20:
        del photos[list(photos)[0]]
    return result


@app.post("/attack")
def attack_upload(image: UploadFile = File(...)):
    info, picture = read_upload(image)
    return attack(picture, info)


@app.get("/examples")
def list_examples():
    return [{key: value for key, value in example.items() if key != "path"} for example in EXAMPLES.values()]


def find_example(example_id):
    if example_id not in EXAMPLES:
        raise HTTPException(404, "Unknown example")
    return EXAMPLES[example_id]


@app.get("/example_image/{example_id}.jpg")
def example_image(example_id: str):
    picture = metadata.load_image(ROOT / find_example(example_id)["path"])
    picture.thumbnail((1024, 1024))
    return jpeg_response(picture)


@app.post("/attack_example/{example_id}")
def attack_example(example_id: str):
    example = find_example(example_id)
    path = ROOT / example["path"]
    truth = {"lat": example["lat"], "lon": example["lon"]}
    result = attack(metadata.load_image(path), metadata.read_metadata(path), truth)
    result["truth"] = truth
    result["error_km"] = error_km(truth, result["location"])
    return result


@app.get("/photo/{photo_id}.jpg")
def photo_image(photo_id: str):
    return jpeg_response(find_photo(photo_id)["image"])


@app.post("/protect")
def protect(
    photo_id: str = Form(..., alias="id"),
    blur_text: bool = Form(True),
    blur_faces: bool = Form(True),
    cloak: bool = Form(True),
):
    saved = find_photo(photo_id)
    before, truth = saved["attack"], saved["truth"]
    start = time.time()
    steps = []
    boxes = []
    if blur_text:
        boxes += [item["box"] for item in before["text"]]
        steps.append(f"Blurred {len(before['text'])} pieces of readable text")
    if blur_faces:
        boxes += [item["box"] for item in before["faces"]]
        steps.append(f"Blurred {len(before['faces'])} faces")
    image = clues.hide(saved["image"], boxes)
    if cloak:
        cloak_start = time.time()
        with gpu:
            image = geo.cloak(image, truth["lat"], truth["lon"])
        steps.append(f"Cloaked the pixels so GeoCLIP guesses wrong ({time.time() - cloak_start:.0f} s)")
    buffer = io.BytesIO()
    metadata.clean_save(image, buffer)
    jpeg = buffer.getvalue()
    removed = [name for name in ("gps", "camera", "taken") if before["metadata"][name]] + before["metadata"]["other"]
    steps.append(f"Saved a clean JPEG with no metadata ({len(removed)} identifying fields removed)")
    saved["protected"] = jpeg

    # attack the saved file again
    protected = metadata.load_image(io.BytesIO(jpeg))
    after_info = metadata.read_metadata(io.BytesIO(jpeg))
    with gpu:
        location = geo.locate(protected)
        text = clues.find_text(protected)
        faces = clues.find_faces(protected)
    error_before, error_after = error_km(truth, before["location"]), error_km(truth, location)
    return {
        "id": photo_id,
        "image_jpeg": base64.b64encode(jpeg).decode(),
        "before": {"location": before["location"], "error_km": error_before, "metadata": before["metadata"]},
        "after": {
            "location": location,
            "text": text,
            "faces": faces,
            "error_km": error_after,
            "error_moved_km": round(error_after - error_before, 1),
            "metadata_found": metadata.has_metadata(io.BytesIO(jpeg)),
            "metadata": after_info,
        },
        "score_before": before["score"],
        "score_after": privacy_score(after_info["gps"] is not None, reach_km(truth, before["location"]), len(text), len(faces), cloaked=cloak),
        "steps": steps,
        "seconds": round(time.time() - start, 1),
    }


@app.get("/protected/{photo_id}.jpg")
def protected_image(photo_id: str):
    saved = find_photo(photo_id)
    if "protected" not in saved:
        raise HTTPException(404, "Run /protect first")
    headers = {"Content-Disposition": 'attachment; filename="unmapped.jpg"'}
    return Response(saved["protected"], media_type="image/jpeg", headers=headers)


@app.get("/config")
def config():
    return {"claude": claude_check.enabled}


# opt-in: sends the photo to Anthropic
@app.post("/claude_check")
def claude_check_photo(photo_id: str = Form(..., alias="id"), which: str = Form("original")):
    saved = find_photo(photo_id)
    if not claude_check.enabled:
        raise HTTPException(400, "No Claude API key set")
    if which == "protected":
        if "protected" not in saved:
            raise HTTPException(404, "Run /protect first")
        image = metadata.load_image(io.BytesIO(saved["protected"]))
    else:
        image = saved["image"]
    guess = claude_check.ask_claude(image)
    if guess is None:
        return {"refused": True}
    if saved["known"]:
        guess["error_km"] = error_km(saved["truth"], guess)
    return guess


def build_profile(names, infos, images, captions, truth=None):
    start = time.time()
    with gpu:
        combined, locations = profiles.combine(images)
    caption_results = profiles.scan_captions([caption for caption in captions if caption.strip()])
    flags = sum(len(result["flags"]) for result in caption_results)
    has_gps = any(info["gps"] is not None for info in infos)
    per_photo = [{"name": name, "metadata": info, "location": location} for name, info, location in zip(names, infos, locations)]
    if truth is None:
        truth = {"lat": combined["lat"], "lon": combined["lon"]}
    return {
        "photos": per_photo,
        "combined": combined,
        "captions": caption_results,
        "score": privacy_score(has_gps, reach_km(truth, combined), flags=flags),
        "seconds": round(time.time() - start, 1),
    }


@app.post("/profile")
def profile_upload(images: list[UploadFile] = File(...), captions: list[str] = Form([])):
    uploads = [read_upload(upload) for upload in images]
    names = [upload.filename for upload in images]
    return build_profile(names, [info for info, _ in uploads], [picture for _, picture in uploads], captions)


@app.post("/profile_example")
def profile_example():
    examples = [example for example in EXAMPLES.values() if example["mode"] == "profile"]
    paths = [ROOT / example["path"] for example in examples]
    names = [example["id"] for example in examples]
    infos = [metadata.read_metadata(path) for path in paths]
    images = [metadata.load_image(path) for path in paths]
    # center of the true spots
    truth = {
        "lat": round(sum(example["lat"] for example in examples) / len(examples), 2),
        "lon": round(sum(example["lon"] for example in examples) / len(examples), 2),
    }
    result = build_profile(names, infos, images, [example["caption"] for example in examples], truth)
    result["truth"] = truth
    result["error_km"] = error_km(truth, result["combined"])
    for photo, example in zip(result["photos"], examples):
        photo["error_km"] = error_km(example, photo["location"])
    return result


app.mount("/demo", StaticFiles(directory=ROOT / "demo"), name="demo")
if (ROOT / "frontend").exists():
    app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")
