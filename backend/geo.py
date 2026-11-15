import math
import random

import numpy as np
import torch
import torch.nn.functional as F
from geoclip import GeoCLIP
from PIL import Image

device = "mps" if torch.backends.mps.is_available() else "cpu"

model = GeoCLIP().to(device).eval()
for param in model.parameters():
    param.requires_grad = False

# encode the 100K candidate locations
gallery = model.gps_gallery.to(device)
with torch.no_grad():
    gallery_features = F.normalize(model.location_encoder(gallery), dim=1)

CLIP_MEAN = torch.tensor([0.48145466, 0.4578275, 0.40821073], device=device).view(1, 3, 1, 1)
CLIP_STD = torch.tensor([0.26862954, 0.26130258, 0.27577711], device=device).view(1, 3, 1, 1)


# image to tensor
def to_pixels(image):
    array = np.asarray(image.convert("RGB"), dtype=np.float32) / 255
    return torch.from_numpy(array).permute(2, 0, 1).unsqueeze(0).to(device)


# tensor to image
def to_image(pixels):
    array = pixels.squeeze(0).permute(1, 2, 0).clamp(0, 1).cpu().numpy()
    return Image.fromarray(np.round(array * 255).astype(np.uint8))


# resize + crop to GeoCLIP's 224x224 input
def model_view(pixels):
    height, width = pixels.shape[2:]
    scale = 224 / min(height, width)
    size = (max(224, round(height * scale)), max(224, round(width * scale)))
    small = F.interpolate(pixels, size=size, mode="bilinear", antialias=True, align_corners=False)
    top = (size[0] - 224) // 2
    left = (size[1] - 224) // 2
    square = small[:, :, top:top + 224, left:left + 224]
    return (square - CLIP_MEAN) / CLIP_STD


# score the view against all 100K places
def view_logits(view):
    features = F.normalize(model.image_encoder(view), dim=1)
    return model.logit_scale.exp() * features @ gallery_features.T


# score a full-size photo
def location_logits(pixels):
    return view_logits(model_view(pixels))


# chance for each of the 100K places
def probabilities(image):
    with torch.no_grad():
        return location_logits(to_pixels(image)).softmax(dim=-1)[0]


# top 5 guesses
def predict(image, top_k=5):
    probs = probabilities(image)
    values, indices = probs.topk(top_k)
    points = gallery[indices].cpu().tolist()
    return [{"lat": lat, "lon": lon, "prob": prob} for (lat, lon), prob in zip(points, values.cpu().tolist())]


RADIUS_STEPS_KM = [1, 5, 25, 100, 500, 2500]


# top guess plus a radius, never under 1 km
def summarize(probs):
    lat, lon = gallery[probs.argmax()].tolist()
    distances = gallery_distances_km(lat, lon)
    # smallest circle holding half the guess
    for radius in RADIUS_STEPS_KM:
        if probs[distances <= radius].sum() >= 0.5:
            break
    values, indices = probs.topk(50)
    # other guesses at least 25 km apart
    top = []
    for (guess_lat, guess_lon), prob in zip(gallery[indices].tolist(), values.tolist()):
        if len(top) < 5 and all(distance_km(guess_lat, guess_lon, kept["lat"], kept["lon"]) >= 25 for kept in top):
            top.append({"lat": round(guess_lat, 2), "lon": round(guess_lon, 2), "prob": round(prob, 4)})
    return {"lat": round(lat, 2), "lon": round(lon, 2), "radius_km": radius, "top": top}


# GeoCLIP's guess for a photo
def locate(image):
    return summarize(probabilities(image))


# haversine distance
def distance_km(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(math.radians, (lat1, lon1, lat2, lon2))
    a = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


# distance to all 100K places
def gallery_distances_km(lat, lon):
    lats, lons = torch.deg2rad(gallery[:, 0]), torch.deg2rad(gallery[:, 1])
    lat, lon = math.radians(lat), math.radians(lon)
    a = torch.sin((lats - lat) / 2) ** 2 + math.cos(lat) * torch.cos(lats) * torch.sin((lons - lon) / 2) ** 2
    return 6371 * 2 * torch.asin(torch.sqrt(a.clamp(0, 1)))


# random crop so the cloak survives cropping
def random_crop(pixels):
    height, width = pixels.shape[2:]
    crop_height = int(height * random.uniform(0.7, 1.0))
    crop_width = int(width * random.uniform(0.7, 1.0))
    top = random.randint(0, height - crop_height)
    left = random.randint(0, width - crop_width)
    return pixels[:, :, top:top + crop_height, left:left + crop_width]


# smaller budget in smooth areas like sky
def texture_budget(pixels, budget):
    gray = pixels.mean(dim=1, keepdim=True)
    detail = (gray - F.avg_pool2d(gray, kernel_size=9, stride=1, padding=4)).abs()
    detail = F.avg_pool2d(detail, kernel_size=9, stride=1, padding=4)
    return budget * (detail / 0.02).clamp(0.25, 1)


# push GeoCLIP's guess far away
def cloak(image, lat, lon, budget=4 / 255, steps=100):
    step_size = budget / 8
    pixels = to_pixels(image)
    limit = texture_budget(pixels, budget)
    distances = gallery_distances_km(lat, lon)
    change = torch.zeros_like(pixels, requires_grad=True)
    for _ in range(steps):
        probs = location_logits(random_crop(pixels + change)).softmax(dim=-1)[0]
        # expected error in km
        expected_error = (probs * distances).sum()
        expected_error.backward()
        with torch.no_grad():
            # step toward more error, cap the change
            change += step_size * change.grad.sign()
            change.copy_(change.clamp(-limit, limit))
            change.copy_((pixels + change).clamp(0, 1) - pixels)
        change.grad.zero_()
    return to_image((pixels + change).detach())
