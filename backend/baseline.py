import json
import sys

from PIL import Image

import geo


def run(manifest_path, output_path):
    photos = json.load(open(manifest_path))
    results = {}
    for name, info in photos.items():
        guesses = geo.predict(Image.open(info["file"]))
        for guess in guesses:
            guess["error_km"] = geo.distance_km(info["lat"], info["lon"], guess["lat"], guess["lon"])
        results[name] = {
            "truth": info,
            "guesses": guesses,
            "error_km": guesses[0]["error_km"],
            "best_of_5_km": min(guess["error_km"] for guess in guesses),
        }
        print(f"{name:16} {guesses[0]['error_km']:9.1f} km   best of 5 {results[name]['best_of_5_km']:9.1f} km")
    json.dump(results, open(output_path, "w"), indent=1)


if __name__ == "__main__":
    run(sys.argv[1], sys.argv[2])
