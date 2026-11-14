import math

import numpy as np
import torch
import torch.nn.functional as F
from geoclip import GeoCLIP
from PIL import Image

device = "mps" if torch.backends.mps.is_available() else "cpu"

model = GeoCLIP().to(device).eval()
for param in model.parameters():
    param.requires_grad = False

gallery = model.gps_gallery.to(device)
with torch.no_grad():
    gallery_features = F.normalize(model.location_encoder(gallery), dim=1)

CLIP_MEAN = torch.tensor([0.48145466, 0.4578275, 0.40821073], device=device).view(1, 3, 1, 1)
CLIP_STD = torch.tensor([0.26862954, 0.26130258, 0.27577711], device=device).view(1, 3, 1, 1)


def to_pixels(image):
    array = np.asarray(image.convert("RGB"), dtype=np.float32) / 255
    return torch.from_numpy(array).permute(2, 0, 1).unsqueeze(0).to(device)


def to_image(pixels):
    array = pixels.squeeze(0).permute(1, 2, 0).clamp(0, 1).cpu().numpy()
    return Image.fromarray(np.round(array * 255).astype(np.uint8))


def model_view(pixels):
    height, width = pixels.shape[2:]
    scale = 224 / min(height, width)
    size = (max(224, round(height * scale)), max(224, round(width * scale)))
    small = F.interpolate(pixels, size=size, mode="bilinear", antialias=True, align_corners=False)
    top = (size[0] - 224) // 2
    left = (size[1] - 224) // 2
    square = small[:, :, top:top + 224, left:left + 224]
    return (square - CLIP_MEAN) / CLIP_STD


def location_logits(pixels):
    features = F.normalize(model.image_encoder(model_view(pixels)), dim=1)
    return model.logit_scale.exp() * features @ gallery_features.T


def predict(image, top_k=5):
    with torch.no_grad():
        probs = location_logits(to_pixels(image)).softmax(dim=-1)[0]
    values, indices = probs.topk(top_k)
    points = gallery[indices].cpu().tolist()
    return [{"lat": lat, "lon": lon, "prob": p} for (lat, lon), p in zip(points, values.cpu().tolist())]


def distance_km(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(math.radians, (lat1, lon1, lat2, lon2))
    a = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


def gallery_distances_km(lat, lon):
    lats, lons = torch.deg2rad(gallery[:, 0]), torch.deg2rad(gallery[:, 1])
    lat, lon = math.radians(lat), math.radians(lon)
    a = torch.sin((lats - lat) / 2) ** 2 + math.cos(lat) * torch.cos(lats) * torch.sin((lons - lon) / 2) ** 2
    return 6371 * 2 * torch.asin(torch.sqrt(a.clamp(0, 1)))


def cloak(image, lat, lon, budget=4 / 255, steps=100, step_size=0.5 / 255):
    pixels = to_pixels(image)
    distances = gallery_distances_km(lat, lon)
    change = torch.zeros_like(pixels, requires_grad=True)
    for _ in range(steps):
        probs = location_logits(pixels + change).softmax(dim=-1)[0]
        expected_error = (probs * distances).sum()
        expected_error.backward()
        with torch.no_grad():
            change += step_size * change.grad.sign()
            change.clamp_(-budget, budget)
            change.copy_((pixels + change).clamp(0, 1) - pixels)
        change.grad.zero_()
    return to_image((pixels + change).detach())
