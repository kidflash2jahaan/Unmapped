import io
import math

from PIL import ExifTags, Image, ImageCms, ImageOps
from pillow_heif import register_heif_opener

register_heif_opener()

IDENTIFYING = [
    "Software", "HostComputer", "LensMake", "LensModel", "BodySerialNumber", "LensSerialNumber",
    "CameraOwnerName", "Artist", "Copyright", "ImageUniqueID", "OffsetTimeOriginal", "UserComment",
    "GPSAltitude", "GPSImgDirection", "GPSSpeed", "GPSDateStamp", "MakerNote",
]


def to_degrees(values, ref):
    degrees, minutes, seconds = (float(value) for value in values)
    sign = -1 if ref in ("S", "W") else 1
    return sign * (degrees + minutes / 60 + seconds / 3600)


# drop padding some cameras add
def clean_text(value):
    return str(value).split("\x00")[0].strip()


def read_metadata(file):
    exif = Image.open(file).getexif()
    tags = {ExifTags.TAGS.get(key, key): value for key, value in exif.items()}
    tags.update({ExifTags.TAGS.get(key, key): value for key, value in exif.get_ifd(ExifTags.IFD.Exif).items()})
    tags.update({ExifTags.GPSTAGS.get(key, key): value for key, value in exif.get_ifd(ExifTags.IFD.GPSInfo).items()})
    location = None
    if "GPSLatitude" in tags and "GPSLongitude" in tags:
        lat = to_degrees(tags["GPSLatitude"], tags.get("GPSLatitudeRef"))
        lon = to_degrees(tags["GPSLongitude"], tags.get("GPSLongitudeRef"))
        # broken GPS values like 37/0
        if math.isfinite(lat) and math.isfinite(lon):
            location = {"lat": round(lat, 2), "lon": round(lon, 2)}
    camera = " ".join(clean_text(tags[name]) for name in ("Make", "Model") if name in tags) or None
    taken = tags.get("DateTimeOriginal") or tags.get("DateTime")
    other = [name for name in IDENTIFYING if name in tags]
    return {"gps": location, "camera": camera, "taken": clean_text(taken) if taken else None, "other": other}


def load_image(file):
    image = ImageOps.exif_transpose(Image.open(file))
    # phone colors (like Display P3) to standard sRGB
    if image.mode == "RGB" and "icc_profile" in image.info:
        image = ImageCms.profileToProfile(image, io.BytesIO(image.info["icc_profile"]), ImageCms.createProfile("sRGB"))
    image = image.convert("RGB")
    # cap size so OCR and the cloak stay fast
    image.thumbnail((2048, 2048))
    return image


def clean_save(image, file):
    # fresh copy carries no metadata
    fresh = Image.new("RGB", image.size)
    fresh.paste(image)
    fresh.save(file, "JPEG", quality=95)


def has_metadata(file):
    image = Image.open(file)
    return len(image.getexif()) > 0 or "xmp" in image.info
