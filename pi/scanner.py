"""Jondo Time Clock - Pi face-recognition scanner.

Three threads share one camera:

  1. capture thread   - continuously reads frames from the camera
                        at full speed into shared state.
  2. detection loop   - (main thread) grabs the latest frame, runs
                        face detection + matching, posts punches,
                        and publishes detection boxes for the
                        overlay.
  3. stream server    - an MJPEG HTTP server that serves the latest
                        frame with face boxes drawn on it, so staff
                        can see themselves on the kiosk screen.

Only the capture thread ever touches the camera object — the CSI
camera allows a single consumer, so everything else works off the
shared latest-frame.

Anti-double-clock-in defences (unchanged):
  - cooldown per employee
  - a face must be the dominant subject for MIN_HOLD_SEC
  - >= 2 reference photos must match (or 1 if only 1 enrolled)
"""

import logging
import os
import socket
import sys
import threading
import time
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
import numpy as np
import requests
from dotenv import load_dotenv

from camera import CameraSource
from sync import FaceCache

try:
    import face_recognition
except ImportError:
    raise SystemExit("face_recognition not installed — see README.md")

log = logging.getLogger("pi.scanner")

DEFAULTS = {
    "BASE_URL": "http://192.168.23.12:3000",
    "API_TOKEN": "",
    "CAMERA_KIND": "auto",
    "CAMERA_INDEX": "0",
    "CAMERA_WIDTH": "640",
    "CAMERA_HEIGHT": "480",
    "CACHE_DIR": str(Path(__file__).parent / "cache"),
    "MATCH_THRESHOLD": "0.50",
    "MIN_HOLD_SEC": "1.5",
    "COOLDOWN_SEC": "60",
    "SYNC_EVERY_SEC": "300",
    "FRAME_SCALE": "0.5",
    "AUDIT_BATCH_EVERY": "30",
    "PI_HOST": socket.gethostname(),
    "LOG_LEVEL": "INFO",
    "STREAM_ENABLED": "true",
    "STREAM_PORT": "8080",
}


def cfg(key):
    return os.environ.get(key, DEFAULTS[key])


# ---------------------------------------------------------------
# Shared state between the three threads
# ---------------------------------------------------------------
class SharedState:
    def __init__(self):
        self._lock = threading.Lock()
        self._frame = None        # latest full-res RGB ndarray
        self._detections = []     # list of {box, label, matched}

    def set_frame(self, f):
        with self._lock:
            self._frame = f

    def get_frame(self):
        with self._lock:
            return self._frame

    def set_detections(self, d):
        with self._lock:
            self._detections = d

    def get_detections(self):
        with self._lock:
            return list(self._detections)


# ---------------------------------------------------------------
# Camera capture thread
# ---------------------------------------------------------------
def capture_loop(cam, shared, stop_event):
    log.info("capture thread started")
    fails = 0
    while not stop_event.is_set():
        frame = cam.read()
        if frame is None:
            fails += 1
            if fails % 50 == 0:
                log.warning("capture: %d consecutive empty reads", fails)
            time.sleep(0.1)
            continue
        fails = 0
        shared.set_frame(frame)
        time.sleep(0.03)   # ~30fps ceiling; camera may be slower
    log.info("capture thread stopped")


# ---------------------------------------------------------------
# MJPEG streaming server
# ---------------------------------------------------------------
def draw_overlay(rgb_frame, detections):
    """Return a BGR JPEG-ready frame with face boxes drawn."""
    bgr = cv2.cvtColor(rgb_frame, cv2.COLOR_RGB2BGR)
    for d in detections:
        top, right, bottom, left = d["box"]
        if d["matched"]:
            colour = (0, 170, 0)        # green (BGR)
            label = d.get("label") or "matched"
        else:
            colour = (60, 60, 230)      # red (BGR)
            label = "searching..."
        cv2.rectangle(bgr, (left, top), (right, bottom), colour, 3)
        # label background
        cv2.rectangle(bgr, (left, bottom), (right, bottom + 26), colour, cv2.FILLED)
        cv2.putText(bgr, label, (left + 6, bottom + 19),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)
    return bgr


class StreamHandler(BaseHTTPRequestHandler):
    shared = None   # set as a class attribute before serving

    # Silence the default per-request logging — too noisy.
    def log_message(self, fmt, *args):
        pass

    def _send_plain(self, code, text):
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        try:
            self.wfile.write(text.encode("utf-8"))
        except Exception:
            pass

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", "/stream", "/stream.mjpg"):
            self._serve_stream()
        elif path in ("/snapshot", "/snapshot.jpg"):
            self._serve_snapshot()
        elif path in ("/health", "/healthz"):
            self._send_plain(200, "ok")
        else:
            self._send_plain(404, "not found")

    def _encoded_frame(self):
        frame = self.shared.get_frame()
        if frame is None:
            return None
        bgr = draw_overlay(frame, self.shared.get_detections())
        ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, 75])
        if not ok:
            return None
        return buf.tobytes()

    def _serve_snapshot(self):
        jpg = self._encoded_frame()
        if jpg is None:
            return self._send_plain(503, "no frame yet")
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(jpg)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(jpg)

    def _serve_stream(self):
        self.send_response(200)
        self.send_header("Age", "0")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Content-Type",
                         "multipart/x-mixed-replace; boundary=frame")
        self.end_headers()
        try:
            while True:
                jpg = self._encoded_frame()
                if jpg is None:
                    time.sleep(0.1)
                    continue
                self.wfile.write(b"--frame\r\n")
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(jpg)))
                self.end_headers()
                self.wfile.write(jpg)
                self.wfile.write(b"\r\n")
                time.sleep(0.08)   # ~12fps cap on the stream
        except (BrokenPipeError, ConnectionResetError):
            pass   # browser closed the tab — normal
        except Exception as e:
            log.debug("stream client error: %s", e)


def start_stream_server(shared, port):
    StreamHandler.shared = shared
    server = ThreadingHTTPServer(("0.0.0.0", port), StreamHandler)
    th = threading.Thread(target=server.serve_forever, daemon=True)
    th.start()
    log.info("MJPEG stream server on http://0.0.0.0:%d/stream", port)
    return server


# ---------------------------------------------------------------
# Network helpers
# ---------------------------------------------------------------
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


# ---------------------------------------------------------------
# Main
# ---------------------------------------------------------------
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
    stream_enabled = cfg("STREAM_ENABLED").lower() in ("1", "true", "yes", "on")
    stream_port = int(cfg("STREAM_PORT"))

    cache = FaceCache(Path(cfg("CACHE_DIR")))
    cache.load_from_disk()
    log.info("initial sync from %s ...", base_url)
    cache.sync(base_url, token)

    cam = CameraSource(
        prefer=cfg("CAMERA_KIND"),
        index=int(cfg("CAMERA_INDEX")),
        width=int(cfg("CAMERA_WIDTH")),
        height=int(cfg("CAMERA_HEIGHT")),
    )
    log.info("camera kind = %s", cam.kind)

    shared = SharedState()
    stop_event = threading.Event()

    capture_thread = threading.Thread(
        target=capture_loop, args=(cam, shared, stop_event), daemon=True)
    capture_thread.start()

    stream_server = None
    if stream_enabled:
        try:
            stream_server = start_stream_server(shared, stream_port)
        except Exception as e:
            log.error("could not start stream server: %s", e)

    last_punch = {}
    last_match = {"emp": None, "since": 0.0}
    last_sync = time.time()
    last_audit_flush = time.time()
    audit_buf = []

    log.info("scanner running (threshold=%.2f, hold=%.1fs, cooldown=%ds)",
             threshold, min_hold, int(cooldown))

    try:
        while True:
            rgb_full = shared.get_frame()
            if rgb_full is None:
                time.sleep(0.1)
                continue

            if frame_scale != 1.0:
                rgb = cv2.resize(rgb_full, (0, 0), fx=frame_scale, fy=frame_scale)
            else:
                rgb = rgb_full

            boxes = face_recognition.face_locations(rgb, model="hog")
            inv = 1.0 / frame_scale if frame_scale else 1.0

            match_emp = None
            match_dist = None
            detections = []

            if boxes:
                boxes.sort(key=lambda b: (b[2]-b[0]) * (b[1]-b[3]), reverse=True)
                # The biggest face is the matching candidate.
                primary = boxes[0]
                enc = face_recognition.face_encodings(rgb, [primary]) if cache.embeddings else []
                if enc:
                    dists = np.linalg.norm(np.stack(cache.embeddings) - enc[0], axis=1)
                    hits = defaultdict(list)
                    for i, d in enumerate(dists):
                        if d <= threshold:
                            hits[cache.labels[i]].append(float(d))
                    if hits:
                        best = sorted(hits.items(),
                                      key=lambda kv: (-len(kv[1]), float(np.mean(kv[1]))))[0]
                        emp, ds = best
                        enrolled_for_emp = sum(1 for L in cache.labels if L == emp)
                        needed = 2 if enrolled_for_emp >= 2 else 1
                        if len(ds) >= needed:
                            match_emp = emp
                            match_dist = float(min(ds))

                # Build overlay detections for ALL faces (full-res coords).
                for idx, b in enumerate(boxes):
                    full = (int(b[0]*inv), int(b[1]*inv), int(b[2]*inv), int(b[3]*inv))
                    is_primary = (idx == 0)
                    detections.append({
                        "box": full,
                        "matched": bool(is_primary and match_emp),
                        "label": match_emp if (is_primary and match_emp) else None,
                    })

            shared.set_detections(detections)

            now = time.time()
            if match_emp:
                if last_match["emp"] != match_emp:
                    last_match = {"emp": match_emp, "since": now}
                elif now - last_match["since"] >= min_hold:
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

            time.sleep(0.05)
    finally:
        stop_event.set()
        if stream_server is not None:
            stream_server.shutdown()
        cam.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nbye")
