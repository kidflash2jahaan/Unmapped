import re

import torch

import geo

FLAGS = {
    "school": r"\b(freshman|sophomore|junior|senior|first day|class of|\d{1,2}(th|st|nd|rd) grade|high school|middle school|homeroom)\b",
    "team or club": r"\b(team|club|varsity|jv|practice|game day|tournament|robotics|band|choir|squad)\b",
    "place": r"\b(street|st|avenue|ave|blvd|boulevard|road|beach|park|mall|downtown|pier)\b",
    "home": r"\b(home|my house|my room|backyard|neighborhood|next door)\b",
    "age": r"\b(\d{1,2} ?(years old|yrs old|yo)|turning \d{1,2}|sweet sixteen|\d{1,2}(th|st|nd|rd) birthday)\b",
    "routine": r"\b(every (morning|day|night|week|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|daily|usual spot|after school|before school)\b",
    "hashtag": r"#\w+",
}
# "at Starbucks", "in Irvine"
NAMED_PLACE = r"\b(?:at|in) ([A-Z][a-z]+(?: [A-Z][a-z]+)*)"


def scan_captions(captions):
    results = []
    for caption in captions:
        flags = []
        for kind, pattern in FLAGS.items():
            for match in re.finditer(pattern, caption, re.IGNORECASE):
                flags.append({"kind": kind, "match": match.group(0)})
        for match in re.finditer(NAMED_PLACE, caption):
            flags.append({"kind": "named place", "match": match.group(1)})
        results.append({"caption": caption, "flags": flags})
    return results


# adding log-probabilities = multiplying the photos' guesses
def combine(images):
    total = 0
    photos = []
    with torch.no_grad():
        for image in images:
            log_probs = geo.location_logits(geo.to_pixels(image)).log_softmax(dim=-1)[0]
            photos.append(geo.summarize(log_probs.exp()))
            total = total + log_probs
    return geo.summarize(total.softmax(dim=-1)), photos
