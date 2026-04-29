"""Jondo Time Clock — Pi face-recognition scanner.

Continuously captures frames from the camera, detects faces, and if
one matches an enrolled employee with high enough confidence, posts
to the dashboard's /api/punch to clock them in/out.

Anti-double-clock-in defences:
 - A given empfullname can't be punched twice within COOLDOWN_SEC
   (default 60s).
 - A face must be the dominant subject for at least MIN_HOLD_SEC
   (default 1.5s) before we trust the match — stops people getting
   clocked in just by walking past.
 - We require the match distance to be <= MATCH_THRESHOLD across at
   least two different reference photos of the same person.

This is a STARTING POINT, not a finished product. Tune the
thresholds for your lighting and camera before going live. See
README.md.
"""

import logging
import os
import socket
import sys
import time
from collections import deque
from pathlib import Path

import cv2
import numpy as np
import requests
from dotenv import load_dotenv

from sync import FaceCache

try:
    import face_recognition
except ImportError:
    raise SystemExit("face_recognition not installed — see README.md")

log = logging.getLogger("pi.scanner")

# --- defaults; override via .env ---
DEFAULTS = {
    "BASE_URL": "http://192.168.23.12:3000",
    "API_TOKEN": "",
    "CAMERA_INDEX": "0",
    "CACHE_DIR": str(Path(__file__).parent / "cache"),
    "MATCH_THRESHOLD": "0.50",   # lower = stricter. 0.6 is dlib default.
    "MIN_HOLD_SEC": "1.5",
    "COOLDOWN_SEC": "60",
    "SYNC_EVERY_SEC": "300",
    "FRAME_SCALE": "0.5",        # downscale frames before detection
    "AUDIT_BATCH_EVERY": "30",   # send buffered events every N seconds
    "PI_HOST": socket.gethostname(),
    "LOG_LEVEL": "INFO",
}


def cfg(key):
    return os.environ.get(key, DEFAULTS[key])


def post_punch(base_url, token, empfullname, confidence, pi_host):
    try:
        r = requests.post(
            base_url.rstrip("/") + "/api/punch",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "empfullname": empfullname,
                "confidence": float(confidence),
                "pi_host": pi_host,
            },
            timeout=10,
        )
        if r.ok:
            data = r.json()
            log.info("PUNCH OK: %s -> %s", empfullname, data.get("action"))
            return data
        log.warning("PUNCH FAILED %s: %s", r.status_code, r.text[:200])
    except Exception as e:
        log.error("PUNCH error: %s", e)
    return None


def post_audit(base_url, token, events, pi_host):
    if not events:
        return
    try:
        requests.post(
            base_url.rstrip("/") + "/api/face-events",
            headers={"Authorization": f"Bearer {token}"},
            json={"pi_host": pi_host, "events": events},
            timeout=10,
        )
    except Exception as e:
        log.warning("audit post failed: %s", e)


def main():
    load_dotenv(Path(__file__).parent / ".env")
    logging.basicConfig(
        level=cfg("LOG_LEVEL"),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    base_url = cfg("BASE_URL")
    token = cfg("API_TOKEN")
    if not token:
        sys.exit("API_TOKEN is required (set in .env)")

    pi_host = cfg("PI_HOST")
    threshold = float(cfg("MATCH_THRESHOLD"))
    min_hold = float(cfg("MIN_HOLD_SEC"))
    cooldown = float(cfg("COOLDOWN_SEC"))
    sync_every = float(cfg("SYNC_EVERY_SEC"))
    frame_scale = float(cfg("FRAME_SCALE"))
    audit_every = float(cfg("AUDIT_BATCH_EVERY"))
    cam_idx = int(cfg("CAMERA_INDEX"))

    cache = FaceCache(Path(cfg("CACHE_DIR")))
    cache.load_from_disk()
    log.info("initial sync from %s …", base_url)
    cache.sync(base_url, token)

    cap = cv2.VideoCapture(cam_idx)
    if not cap.isOpened():
        sys.exit(f"could not open camera index {cam_idx}")
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)

    last_punch = {}                    # empfullname -> ts
    last_match = {"emp": None, "since": 0.0}
    last_sync = time.time()
    last_audit_flush = time.time()
    audit_buf = []

    log.info("scanner running (threshold=%.2f, hold=%.1fs, cooldown=%ds)",
             threshold, min_hold, int(cooldown))

    while True:
        ok, frame = cap.read()
        if not ok:
            time.sleep(0.1)
            continue

        # Downscale for speed; face_recognition runs on RGB.
        small = cv2.resize(frame, (0, 0), fx=frame_scale, fy=frame_scale)
        rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)

        boxes = face_recognition.face_locations(rgb, model="hog")
        match_emp = None
        match_dist = None
        if boxes and cache.embeddings:
            # Use the biggest face only.
            boxes.sort(key=lambda b: (b[2]-b[0]) * (b[1]-b[3]), reverse=True)
            enc = face_recognition.face_encodings(rgb, [boxes[0]])
            if enc:
                # Distance to every reference embedding.
                dists = np.linalg.norm(np.stack(cache.embeddings) - enc[0], axis=1)
                # For each candidate person, count how many of THEIR
                # photos match. Require at least 2 hits within threshold
                # to confirm (or 1 if the person only has 1 enrolled photo).
                from collections import defaultdict
                hits = defaultdict(list)
                for i, d in enumerate(dists):
                    if d <= threshold:
                        hits[cache.labels[i]].append(d)
                if hits:
                    # Best person = most hits, then lowest mean distance
                    best = sorted(hits.items(),
                                  key=lambda kv: (-len(kv[1]), float(np.mean(kv[1]))))[0]
                    emp, ds = best
                    enrolled_for_emp = sum(1 for L in cache.labels if L == emp)
                    needed = 2 if enrolled_for_emp >= 2 else 1
                    if len(ds) >= needed:
                        match_emp = emp
                        match_dist = float(min(ds))

        # Hold-tracking — only act when the same person has been the
        # match for at least min_hold seconds.
        now = time.time()
        if match_emp:
            if last_match["emp"] != match_emp:
                last_match = {"emp": match_emp, "since": now}
            elif now - last_match["since"] >= min_hold:
                # Cool-down check
                if now - last_punch.get(match_emp, 0) > cooldown:
                    confidence = max(0.0, min(1.0, 1.0 - (match_dist or 1.0)))
                    res = post_punch(base_url, token, match_emp, confidence, pi_host)
                    if res:
                        last_punch[match_emp] = now
                        last_match = {"emp": None, "since": 0.0}
                else:
                    log.debug("%s within cooldown", match_emp)
        else:
            if last_match["emp"]:
                last_match = {"emp": None, "since": 0.0}
            if boxes and not cache.embeddings:
                audit_buf.append({"action": "no_embeddings", "reason": "cache empty"})
            elif boxes:
                audit_buf.append({"action": "rejected", "confidence": None,
                                  "reason": "no match within threshold"})
            elif not boxes:
                pass  # quiet — no face, no audit row

        # Periodic background tasks
        if now - last_sync > sync_every:
            try:
                cache.sync(base_url, token)
            except Exception as e:
                log.warning("sync failed: %s", e)
            last_sync = now

        if now - last_audit_flush > audit_every and audit_buf:
            post_audit(base_url, token, audit_buf[-200:], pi_host)
            audit_buf.clear()
            last_audit_flush = now

        # Light sleep — keeps CPU tame on a Pi 4.
        time.sleep(0.05)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nbye")
