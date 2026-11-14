import numpy as np
import objc
import torch
import torch.nn.functional as F
import Vision
from ocrmac import ocrmac
from PIL import Image, ImageFilter
from transformers import AutoTokenizer

import geo


# whole photo plus a 3x3 grid of overlapping half-size tiles
def tiles(image):
    width, height = image.size
    boxes = [(0, 0, width, height)]
    for top in (0, height // 4, height // 2):
        for left in (0, width // 4, width // 2):
            boxes.append((left, top, left + width // 2, top + height // 2))
    return boxes


# Vision boxes go 0 to 1 from the bottom left
def to_image_box(box, tile):
    x, y, w, h = box
    left, top, right, bottom = tile
    tile_width, tile_height = right - left, bottom - top
    return [
        max(left, round(left + x * tile_width)),
        max(top, round(top + (1 - y - h) * tile_height)),
        min(right, round(left + (x + w) * tile_width)),
        min(bottom, round(top + (1 - y) * tile_height)),
    ]


def overlap(a, b):
    width = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    height = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    smaller = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    return width * height / max(smaller, 1)


# keep the most confident of overlapping boxes
def merge(found):
    kept = []
    for item in sorted(found, key=lambda item: (item["confidence"], len(item.get("text", ""))), reverse=True):
        if all(overlap(item["box"], other["box"]) < 0.5 for other in kept):
            kept.append(item)
    return kept


# join pieces of the same sign into one clue
def group_signs(items):
    groups = []
    for item in sorted(items, key=lambda item: item["box"][1]):
        left, top, right, bottom = item["box"]
        pad = (bottom - top) / 2
        for group in groups:
            g_left, g_top, g_right, g_bottom = group["box"]
            if left - pad < g_right and right + pad > g_left and top - pad < g_bottom and bottom + pad > g_top:
                group["box"] = [min(left, g_left), min(top, g_top), max(right, g_right), max(bottom, g_bottom)]
                group["text"] += " " + item["text"]
                group["confidence"] = max(group["confidence"], item["confidence"])
                break
        else:
            groups.append(dict(item))
    return groups


def find_text(image):
    found = []
    # free Apple Vision memory after each call
    with objc.autorelease_pool():
        for tile in tiles(image):
            for text, confidence, box in ocrmac.OCR(image.crop(tile), recognition_level="accurate").recognize():
                if confidence >= 0.4 and len(text.strip()) >= 2:
                    found.append({"text": text, "confidence": round(confidence, 2), "box": to_image_box(box, tile)})
    return group_signs(merge(found))


def find_faces(image):
    found = []
    with objc.autorelease_pool():
        for tile in tiles(image):
            request = Vision.VNDetectFaceRectanglesRequest.alloc().init()
            handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(ocrmac.pil2buf(image.crop(tile)), None)
            handler.performRequests_error_([request], None)
            for face in request.results() or []:
                box = face.boundingBox()
                corners = (box.origin.x, box.origin.y, box.size.width, box.size.height)
                found.append({"confidence": round(float(face.confidence()), 2), "box": to_image_box(corners, tile)})
    return merge(found)


clip = geo.model.image_encoder.CLIP
tokenizer = AutoTokenizer.from_pretrained("openai/clip-vit-large-patch14")
TEMPLATES = ["a photo of {}.", "a street photo with {}.", "a picture showing {}."]
PHRASES = [
    "palm trees", "desert scrub and cactus", "snow on the ground", "red spanish tile roofs",
    "brick row houses", "wooden houses", "a road with double yellow center lines", "lush tropical jungle",
    "mountains", "a sandy ocean beach", "a downtown skyscraper skyline", "a narrow european shopping street",
    "a river with a bridge", "a pine forest", "a big american parking lot", "a green grass lawn",
    "dry golden grass hills",
]


# average 3 wordings of each phrase
with torch.no_grad():
    phrase_features = []
    for phrase in PHRASES:
        tokens = tokenizer([template.format(phrase) for template in TEMPLATES], padding=True, return_tensors="pt").to(geo.device)
        wordings = F.normalize(clip.get_text_features(**tokens).pooler_output, dim=1)
        phrase_features.append(F.normalize(wordings.mean(dim=0), dim=0))
    phrase_features = torch.stack(phrase_features)


def padded(image):
    side = max(image.size)
    square = Image.new("RGB", (side, side), (124, 116, 104))
    square.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
    return square


def ambient_clues(image):
    with torch.no_grad():
        # center crop and whole photo
        views = torch.cat([geo.model_view(geo.to_pixels(image)), geo.model_view(geo.to_pixels(padded(image)))])
        image_features = F.normalize(clip.get_image_features(pixel_values=views).pooler_output, dim=1).mean(dim=0)
        scores = phrase_features @ F.normalize(image_features, dim=0)
    # how far each phrase stands out
    z_scores = ((scores - scores.mean()) / scores.std()).tolist()
    ranked = sorted(zip(PHRASES, z_scores), key=lambda pair: -pair[1])
    return [{"clue": f"looks like {phrase}", "score": round(z, 2)} for phrase, z in ranked[:3] if z > 1.5]


# log odds the photo is within 100 km of the top guess
def near_odds(logits, near):
    return torch.logsumexp(logits[:, near], dim=1) - torch.logsumexp(logits[:, ~near], dim=1)


def heatmap(image, grid=7):
    view = geo.model_view(geo.to_pixels(image))
    cell = 224 // grid
    with torch.no_grad():
        logits = geo.view_logits(view)
        lat, lon = geo.gallery[logits[0].argmax()].tolist()
        near = geo.gallery_distances_km(lat, lon) < 100
        before = near_odds(logits, near)
        # blur by shrinking to 16x16 and back
        blurry =F.interpolate(F.interpolate(view, size=16, mode="area"), size=224, mode="bilinear")
        # one copy per patch, with that patch blurred
        batch = view.repeat(grid * grid, 1, 1, 1)
        for row in range(grid):
            for col in range(grid):
                y, x = row * cell, col * cell
                batch[row * grid + col, :, y:y + cell, x:x + cell] = blurry[0, :, y:y + cell, x:x + cell]
        after = torch.cat([near_odds(geo.view_logits(chunk), near) for chunk in batch.split(25)])
    drops = (before - after).clamp(min=0).view(grid, grid)
    return [[round(drop, 3) for drop in row] for row in drops.tolist()]


def overlay(image, heat):
    width, height = image.size
    side = min(width, height)
    left, top = (width - side) // 2, (height - side) // 2
    # no rescaling, so weak maps stay faint
    strength = np.clip(np.array(heat, dtype=np.float32), 0, 1)
    strength = np.clip(np.asarray(Image.fromarray(strength).resize((side, side), Image.BICUBIC)), 0, 1)
    # dim the strips GeoCLIP never sees
    pixels = np.asarray(image, dtype=np.float32) * 0.4
    square = np.asarray(image.crop((left, top, left + side, top + side)), dtype=np.float32)
    alpha = 0.65 * strength[:, :, None]
    pixels[top:top + side, left:left + side] = square * (1 - alpha) + np.array([255, 30, 30]) * alpha
    return Image.fromarray(pixels.astype(np.uint8))


def hide(image, boxes):
    result = image.copy()
    for left, top, right, bottom in boxes:
        # grow by 20% of the box height
        pad = 0.2 * (bottom - top)
        box = (max(0, int(left - pad)), max(0, int(top - pad)), min(image.width, int(right + pad)), min(image.height, int(bottom + pad)))
        radius = max(6, (box[3] - box[1]) // 3)
        result.paste(result.crop(box).filter(ImageFilter.GaussianBlur(radius)), box)
    return result
