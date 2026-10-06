"""Local server for Lead Hunt.

Serves the dashboard and looks up real local businesses:
OpenStreetMap by default, plus Google Places ratings and reviews
when GOOGLE_PLACES_API_KEY is set in .env.

Run: python server.py   then open http://127.0.0.1:8765
"""
import hashlib
import json
import math
import os
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CACHE_DIR = ROOT / ".cache"
CACHE_TTL = 24 * 3600
USER_AGENT = "lead-hunt/0.1 (local research tool)"
NOMINATIM = "https://nominatim.openstreetmap.org/search?"
RADIUS_M = 7000
MAX_DISTRICTS = 6
MAX_PER_DISTRICT = 14

# niche -> search phrases Nominatim understands, and the OSM tags that confirm a result belongs to it
NICHES = {
    "Barbers and hair salons": {"phrases": ["hairdresser"], "tags": {("shop", "hairdresser")}},
    "Auto repair": {"phrases": ["car repair"], "tags": {("shop", "car_repair")}},
    "Dentists": {"phrases": ["dentist"], "tags": {("amenity", "dentist")}},
    "Beauty and nail salons": {"phrases": ["beauty"], "tags": {("shop", "beauty")}},
    "Laundry and dry cleaning": {"phrases": ["laundry", "dry cleaning"], "tags": {("shop", "laundry"), ("shop", "dry_cleaning")}},
}
SOCIAL_HOSTS = ("facebook.com", "instagram.com", "yelp.com", "linktr.ee", "tiktok.com", "twitter.com", "x.com", "booksy.com", "vagaro.com")
DEAD_STATUS = {404, 410, 500, 502, 503, 521, 522, 523}
ASKS = re.compile(r"\b(call|called|calling|phone|hours|website|online|book|booking|appointment|price|prices|pricing)\b", re.I)


def load_env():
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def http_json(url, data=None, headers=None, timeout=40):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def distance_m(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(a))


def geocode(city):
    query = urllib.parse.urlencode({"q": city, "format": "jsonv2", "limit": 1, "addressdetails": 1})
    found = http_json(NOMINATIM + query)
    if not found:
        raise LookupError('Could not find "%s" on the map. Try a format like "Austin, TX".' % city)
    place = found[0]
    address = place.get("address", {})
    name = address.get("city") or address.get("town") or address.get("village") or place.get("name") or city
    state = (address.get("ISO3166-2-lvl4") or "").split("-")[-1]
    return {"label": name + (", " + state if state else ""), "lat": float(place["lat"]), "lon": float(place["lon"])}


def search_businesses(center, niches):
    dlat = RADIUS_M / 111000
    dlon = dlat / max(0.2, math.cos(math.radians(center["lat"])))
    viewbox = "%f,%f,%f,%f" % (center["lon"] - dlon, center["lat"] + dlat, center["lon"] + dlon, center["lat"] - dlat)
    seen, out = set(), []
    for niche in niches:
        for phrase in NICHES[niche]["phrases"]:
            time.sleep(1.1)  # Nominatim's usage policy allows one request per second
            query = urllib.parse.urlencode({"q": phrase, "format": "jsonv2", "limit": 40, "viewbox": viewbox, "bounded": 1, "addressdetails": 1, "extratags": 1})
            for row in http_json(NOMINATIM + query):
                b = to_business(row, niche)
                if b and b["url"] not in seen:
                    seen.add(b["url"])
                    out.append(b)
    return out


def to_business(row, niche):
    if (row.get("category"), row.get("type")) not in NICHES[niche]["tags"] or not row.get("name"):
        return None
    tags = row.get("extratags") or {}
    address = row.get("address") or {}
    website = tags.get("website") or tags.get("contact:website") or tags.get("url") or ""
    social = tags.get("contact:facebook") or tags.get("contact:instagram") or ""
    return {
        "name": row["name"].strip(),
        "niche": niche,
        "lat": float(row["lat"]),
        "lon": float(row["lon"]),
        "address": " ".join(x for x in (address.get("house_number"), address.get("road")) if x),
        "hood": address.get("suburb") or address.get("neighbourhood") or address.get("quarter") or address.get("commercial") or "",
        "phone": tags.get("phone") or tags.get("contact:phone") or "",
        "website": website or social,
        "hours": bool(tags.get("opening_hours")),
        "url": "https://www.openstreetmap.org/%s/%s" % (row.get("osm_type"), row.get("osm_id")),
        "rating": None,
        "reviews": None,
        "quote": "",
    }


def split_into_districts(businesses):
    """Cluster businesses into a few areas and name each area after its most common neighborhood."""
    k = min(MAX_DISTRICTS, max(1, len(businesses) // 4))
    centers = [(businesses[0]["lat"], businesses[0]["lon"])]
    while len(centers) < k:  # farthest-point start keeps the result the same on every run
        far = max(businesses, key=lambda b: min(distance_m(b["lat"], b["lon"], c[0], c[1]) for c in centers))
        centers.append((far["lat"], far["lon"]))
    for _ in range(12):
        groups = [[] for _ in centers]
        for b in businesses:
            groups[min(range(len(centers)), key=lambda i: distance_m(b["lat"], b["lon"], centers[i][0], centers[i][1]))].append(b)
        centers = [(sum(b["lat"] for b in g) / len(g), sum(b["lon"] for b in g) / len(g)) if g else c for g, c in zip(groups, centers)]

    out, used = [], set()
    for group, c in sorted(zip(groups, centers), key=lambda gc: -len(gc[0])):
        if not group:
            continue
        names = [n for n, _ in Counter(b["hood"] for b in group if b["hood"]).most_common() if n not in used]
        name = names[0] if names else "Area %d" % (len(out) + 1)
        used.add(name)
        group = sorted(group, key=lambda b: distance_m(b["lat"], b["lon"], c[0], c[1]))[:MAX_PER_DISTRICT]
        for b in group:
            b["district"] = name
        out.append({"name": name, "businesses": group})
    return out


def is_social(url):
    host = urllib.parse.urlparse(url if "//" in url else "//" + url).netloc.lower()
    return any(host == h or host.endswith("." + h) for h in SOCIAL_HOSTS)


def site_is_dead(url):
    """True only when the site clearly does not exist or does not answer. Slow or bot-blocking sites count as alive."""
    if "//" not in url:
        url = "http://" + url
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) lead-hunt"})
    try:
        with urllib.request.urlopen(req, timeout=7):
            return False
    except urllib.error.HTTPError as err:
        return err.code in DEAD_STATUS
    except urllib.error.URLError as err:
        return isinstance(err.reason, (socket.gaierror, ConnectionRefusedError))
    except (ssl.SSLError, socket.timeout, TimeoutError, ValueError, OSError):
        return False


def google_enrich(b, city_label, key):
    """Fill rating, review count and a review quote from Google Places. Leaves the business untouched on any mismatch."""
    body = {
        "textQuery": ", ".join(x for x in (b["name"], b["address"], city_label) if x),
        "pageSize": 1,
        "locationBias": {"circle": {"center": {"latitude": b["lat"], "longitude": b["lon"]}, "radius": 300.0}},
    }
    mask = "places.displayName,places.location,places.rating,places.userRatingCount,places.websiteUri,places.nationalPhoneNumber,places.googleMapsUri,places.reviews"
    try:
        found = http_json(
            "https://places.googleapis.com/v1/places:searchText",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": mask},
            timeout=20,
        ).get("places", [])
    except (urllib.error.URLError, TimeoutError, ValueError) as err:
        b["_google_error"] = str(err)
        return
    if not found:
        return
    place = found[0]
    loc = place.get("location", {})
    if "latitude" not in loc or distance_m(b["lat"], b["lon"], loc["latitude"], loc["longitude"]) > 400:
        return
    b["rating"] = place.get("rating")
    b["reviews"] = place.get("userRatingCount")
    b["phone"] = b["phone"] or place.get("nationalPhoneNumber", "")
    b["url"] = place.get("googleMapsUri") or b["url"]
    if not b["website"] and place.get("websiteUri"):
        b["website"] = place["websiteUri"]
    for review in place.get("reviews", []):
        text = review.get("text")
        text = text.get("text", "") if isinstance(text, dict) else (text or "")
        for sentence in re.split(r"(?<=[.!?])\s+", text):
            if ASKS.search(sentence) and 30 <= len(sentence) <= 170:
                b["quote"] = sentence.strip()
                return


def add_signals(b):
    sig = []
    if not b["website"]:
        sig.append("nosite")
    elif is_social(b["website"]):
        sig.append("social")
    elif b.pop("_dead", False):
        sig.append("dead")
    if b["phone"]:
        sig.append("phone")
    if not b["hours"]:
        sig.append("nohours")
    if (b["reviews"] or 0) >= 100:
        sig.append("reviews")
    if (b["rating"] or 0) >= 4.5:
        sig.append("rating")
    if b["quote"]:
        sig.append("asks")
    b["sig"] = sig


def hunt(city, niche, fresh=False):
    key = os.environ.get("GOOGLE_PLACES_API_KEY", "").strip()
    niches = [niche] if niche in NICHES else list(NICHES)
    cache_file = CACHE_DIR / (hashlib.sha1(("%s|%s|%s" % (city.lower().strip(), ",".join(niches), bool(key))).encode()).hexdigest() + ".json")
    if not fresh and cache_file.exists() and time.time() - cache_file.stat().st_mtime < CACHE_TTL:
        cached = json.loads(cache_file.read_text(encoding="utf-8"))
        cached["cached"] = True
        return cached

    center = geocode(city)
    businesses = search_businesses(center, niches)
    if not businesses:
        raise LookupError("The map has no matching businesses within %d km of %s." % (RADIUS_M // 1000, center["label"]))

    districts = split_into_districts(businesses)
    shown = [b for d in districts for b in d["businesses"]]
    notes = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        if key:
            # Google is asked only about businesses that look like leads, to keep the bill small.
            candidates = [b for b in shown if not b["website"] or is_social(b["website"])]
            limit = int(os.environ.get("GOOGLE_MAX_CALLS", "40"))
            list(pool.map(lambda b: google_enrich(b, center["label"], key), candidates[:limit]))
            errors = [b.pop("_google_error") for b in shown if "_google_error" in b]
            if errors:
                notes.append("Google Places failed for %d businesses: %s" % (len(errors), errors[0]))
        to_check = [b for b in shown if b["website"] and not is_social(b["website"])]
        for b, dead in zip(to_check, pool.map(lambda b: site_is_dead(b["website"]), to_check)):
            b["_dead"] = dead
    for b in shown:
        add_signals(b)

    result = {
        "city": center,
        "source": "OpenStreetMap + Google Places" if key else "OpenStreetMap",
        "found": len(businesses),
        "districts": districts,
        "notes": notes,
        "cached": False,
    }
    CACHE_DIR.mkdir(exist_ok=True)
    cache_file.write_text(json.dumps(result), encoding="utf-8")
    return result


class Handler(BaseHTTPRequestHandler):
    def send(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, payload):
        self.send(status, json.dumps(payload).encode("utf-8"), "application/json; charset=utf-8")

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(url.query)
        # Only the dashboard itself is served as a file, so .env and the cache can never leak.
        if url.path in ("/", "/lead-hunt.html"):
            return self.send(200, (ROOT / "lead-hunt.html").read_bytes(), "text/html; charset=utf-8")
        if url.path == "/api/config":
            return self.send_json(200, {"niches": list(NICHES), "google": bool(os.environ.get("GOOGLE_PLACES_API_KEY", "").strip())})
        if url.path == "/api/hunt":
            city = params.get("city", [""])[0].strip()
            if not city:
                return self.send_json(400, {"error": "Type a city first, for example Austin, TX."})
            try:
                return self.send_json(200, hunt(city, params.get("niche", [""])[0], fresh="fresh" in params))
            except LookupError as err:
                return self.send_json(404, {"error": str(err)})
            except (urllib.error.URLError, TimeoutError, socket.timeout) as err:
                return self.send_json(502, {"error": "The map service did not answer (%s). Wait a minute and run again." % err})
        self.send_json(404, {"error": "Not found"})

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))


if __name__ == "__main__":
    load_env()
    PORT = int(os.environ.get("PORT", "8765"))
    print("Lead Hunt is running at http://127.0.0.1:%d" % PORT)
    print("Google Places: %s" % ("on" if os.environ.get("GOOGLE_PLACES_API_KEY", "").strip() else "off (OpenStreetMap only)"))
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
