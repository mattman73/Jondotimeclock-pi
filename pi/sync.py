"""Sync reference photos from the dashboard server to local cache,
and (re-)compute face embeddings for matching.

Runs once on startup and then periodically (default every 5 min).

The cache layout on disk:
    cache/photos/<photo_id>.jpg          raw photo bytes
    cache/embeddings/<photo_id>.npy      128-d float32 embedding
    cache/index.json                     {photo_id: {"emp": empfullname,
                                                     "captured": iso8601}}

The Pi stores nothing else — if the dashboard says "delete photo
17", the Pi removes it from cache on next sync. If the dashboard
says employee X is no longer opted-in, all of X's photos disappear
from the API and so from the cache.
"""

import json
import logging
import os
import time
from pathlib import Path

import numpy as np
import requests

try:
    import face_recognition  # dlib-backed
except ImportError as e:  # pragma: no cover
    raise SystemExit(
        "face_recognition not installed. On a Pi run:\n"
        "  sudo apt install -y cmake build-essential libopenblas-dev liblapack-dev libjpeg-dev\n"
        "  pip install face_recognition\n"
        f"(import error was: {e})"
    )

log = logging.getLogger("pi.sync")


class FaceCache:
    """In-memory mirror of the photos+embeddings on disk. Re-loads
    itself when sync() finds new/deleted photos."""

    def __init__(self, cache_dir: Path):
        self.cache_dir = Path(cache_dir)
        self.photo_dir = self.cache_dir / "photos"
        self.emb_dir = self.cache_dir / "embeddings"
        self.index_path = self.cache_dir / "index.json"
        self.photo_dir.mkdir(parents=True, exist_ok=True)
        self.emb_dir.mkdir(parents=True, exist_ok=True)
        self.index = {}  # photo_id (str) -> {emp, captured}
        # Loaded into memory for fast matching:
        self.embeddings = []   # list of np.ndarray (128,)
        self.labels = []       # parallel: list of empfullname strings

    def load_from_disk(self):
        if self.index_path.exists():
            self.index = json.loads(self.index_path.read_text())
        else:
            self.index = {}
        self.embeddings.clear()
        self.labels.clear()
        for pid_str, meta in self.index.items():
            emb_path = self.emb_dir / f"{pid_str}.npy"
            if not emb_path.exists():
                continue
            try:
                emb = np.load(str(emb_path))
                self.embeddings.append(emb)
                self.labels.append(meta["emp"])
            except Exception as e:
                log.warning("could not load embedding %s: %s", pid_str, e)
        log.info("Cache loaded: %d photos, %d embeddings, %d distinct people",
                 len(self.index), len(self.embeddings), len(set(self.labels)))

    def save_index(self):
        self.index_path.write_text(json.dumps(self.index, indent=2))

    def sync(self, base_url: str, token: str):
        """Pull the photo manifest from the server and reconcile
        with the local cache. Returns True if anything changed."""
        try:
            resp = requests.get(
                base_url.rstrip("/") + "/api/faces/photos",
                headers={"Authorization": f"Bearer {token}"},
                timeout=15,
            )
            resp.raise_for_status()
        except Exception as e:
            log.error("sync: manifest fetch failed: %s", e)
            return False

        manifest = resp.json().get("photos", [])
        wanted = {str(p["id"]): p for p in manifest}
        have = set(self.index.keys())

        to_add = [pid for pid in wanted if pid not in have]
        to_remove = [pid for pid in have if pid not in wanted]

        for pid in to_remove:
            log.info("sync: removing photo %s (%s)", pid, self.index[pid].get("emp"))
            for d in (self.photo_dir, self.emb_dir):
                p = d / f"{pid}.jpg" if d is self.photo_dir else d / f"{pid}.npy"
                if p.exists():
                    p.unlink()
            self.index.pop(pid, None)

        for pid in to_add:
            meta = wanted[pid]
            log.info("sync: downloading photo %s (%s)", pid, meta["empfullname"])
            try:
                r = requests.get(
                    base_url.rstrip("/") + f"/api/faces/photos/{pid}",
                    headers={"Authorization": f"Bearer {token}"},
                    timeout=30,
                )
                r.raise_for_status()
                jpg_path = self.photo_dir / f"{pid}.jpg"
                jpg_path.write_bytes(r.content)
                emb = self._compute_embedding(jpg_path)
                if emb is None:
                    log.warning("sync: no face found in photo %s — skipping", pid)
                    jpg_path.unlink(missing_ok=True)
                    continue
                np.save(str(self.emb_dir / f"{pid}.npy"), emb)
                self.index[pid] = {
                    "emp": meta["empfullname"],
                    "captured": meta.get("captured_at", ""),
                }
            except Exception as e:
                log.error("sync: failed to fetch photo %s: %s", pid, e)

        if to_add or to_remove:
            self.save_index()
            self.load_from_disk()
            return True
        # First run after restart even if nothing changed:
        if not self.embeddings:
            self.load_from_disk()
        return False

    @staticmethod
    def _compute_embedding(image_path: Path):
        """Run dlib's HOG detector + 128-d embedding model on a single
        photo. Returns None if no face is found."""
        img = face_recognition.load_image_file(str(image_path))
        boxes = face_recognition.face_locations(img, model="hog")
        if not boxes:
            return None
        # Use the largest face if there are multiple
        boxes.sort(key=lambda b: (b[2] - b[0]) * (b[1] - b[3]), reverse=True)
        encs = face_recognition.face_encodings(img, [boxes[0]])
        return encs[0].astype(np.float32) if encs else None
