import io
import json
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image
from skimage.metrics import peak_signal_noise_ratio, structural_similarity

import geo


def error_km(image, info):
    guess = geo.predict(image, top_k=1)[0]
    return geo.distance_km(info["lat"], info["lon"], guess["lat"], guess["lon"])


# simulate posting to social media
def share(image):
    copy = image.copy()
    copy.thumbnail((1080, 1080), Image.LANCZOS)
    buffer = io.BytesIO()
    copy.save(buffer, "JPEG", quality=75)
    return Image.open(buffer).convert("RGB")


def crop_and_share(image):
    width, height = image.size
    return share(image.crop((width // 10, height // 10, width, height)))


def run(manifest_path, output_dir, budget):
    photos = json.load(open(manifest_path))
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    results = {}
    for name, info in photos.items():
        image = Image.open(info["file"]).convert("RGB")
        start = time.time()
        cloaked = geo.cloak(image, info["lat"], info["lon"], budget=budget / 255)
        seconds = time.time() - start
        cloaked.save(output / f"{name}.png")
        original, changed = np.asarray(image), np.asarray(cloaked)
        results[name] = {
            "before_km": error_km(image, info),
            "after_km": error_km(cloaked, info),
            "shared_before_km": error_km(share(image), info),
            "shared_after_km": error_km(share(cloaked), info),
            "cropped_before_km": error_km(crop_and_share(image), info),
            "cropped_after_km": error_km(crop_and_share(cloaked), info),
            "psnr": peak_signal_noise_ratio(original, changed),
            "ssim": structural_similarity(original, changed, channel_axis=2),
            "seconds": seconds,
        }
        r = results[name]
        print(f"{name:14} {r['before_km']:8.1f} -> {r['after_km']:8.1f} km | shared {r['shared_before_km']:8.1f} -> {r['shared_after_km']:8.1f} km | cropped {r['cropped_before_km']:8.1f} -> {r['cropped_after_km']:8.1f} km | psnr {r['psnr']:.1f} ssim {r['ssim']:.3f} | {seconds:.0f}s", flush=True)
    json.dump(results, open(output / "results.json", "w"), indent=1)


if __name__ == "__main__":
    run(sys.argv[1], sys.argv[2], float(sys.argv[3]))
