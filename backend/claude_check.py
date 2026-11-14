import base64
import io
import os
from pathlib import Path

import anthropic
from pydantic import BaseModel

# read the key from the gitignored .env file
env_file = Path(__file__).parent.parent / ".env"
if env_file.exists():
    for line in env_file.read_text().splitlines():
        name, _, value = line.partition("=")
        os.environ.setdefault(name.strip(), value.strip())

enabled = bool(os.environ.get("ANTHROPIC_API_KEY"))

PROMPT = (
    "Look at this photo and work out where it was taken, as precisely as you can, "
    "judging only from what is visible. Give your single best guess as decimal latitude "
    "and longitude, a short place name, a radius in km you are about 70% sure the true "
    "spot is within, and the visual clues you used."
)


class Guess(BaseModel):
    place: str
    lat: float
    lon: float
    radius_km: float
    clues: list[str]


def ask_claude(image):
    copy = image.convert("RGB")
    copy.thumbnail((1568, 1568))
    buffer = io.BytesIO()
    copy.save(buffer, "JPEG", quality=90)
    data = base64.standard_b64encode(buffer.getvalue()).decode()
    response = anthropic.Anthropic().messages.parse(
        model="claude-opus-5-5",
        max_tokens=16000,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}},
                {"type": "text", "text": PROMPT},
            ],
        }],
        output_format=Guess,
    )
    if response.stop_reason == "refusal":
        return None
    return response.parsed_output.model_dump()
