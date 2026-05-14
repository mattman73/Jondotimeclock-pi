"""Unified camera source for the Pi scanner.

The original PHP/Node kiosk doesn't care about the camera, but the
Pi scanner has to deal with two completely different camera paths:

  - CSI ribbon cameras (Pi Camera Module v1/v2/v3) on Bookworm —
    must go via libcamera, which Python sees through `picamera2`.
    OpenCV's VideoCapture cannot decode the raw Bayer output that
    /dev/video0 emits.
  - USB webcams — open with `cv2.VideoCapture` over V4L2 like any
    other Linux box.

`CameraSource(prefer="auto", ...)` tries to import picamera2 first
(if available, it's a CSI camera setup) and falls back to OpenCV.
You can force one or the other via the `prefer` argument or the
`CAMERA_KIND` env var.

Every read() returns a numpy ndarray in **RGB** order (not BGR) so
the caller can feed it straight to face_recognition without
another colour-space conversion.
"""

import logging
import os

log = logging.getLogger("pi.camera")


class CameraSource:

    def __init__(self, prefer="auto", index=0, width=640, height=480):
        self.kind = None
        self._backend = None
        self.width = width
        self.height = height

        pref = (prefer or "auto").lower()
        # 1. CSI path (picamera2)
        if pref in ("auto", "csi", "picamera2"):
            try:
                self._init_csi(width, height)
                self.kind = "csi"
                return
            except Exception as e:
                if pref != "auto":
                    raise
                log.info("picamera2 unavailable (%s); falling back to USB",
                         type(e).__name__)

        # 2. USB path (OpenCV)
        self._init_usb(index, width, height)
        self.kind = "usb"

    def _init_csi(self, width, height):
        from picamera2 import Picamera2  # apt: python3-picamera2
        self._backend = Picamera2()
        config = self._backend.create_preview_configuration(
            main={"size": (int(width), int(height)), "format": "RGB888"}
        )
        self._backend.configure(config)
        self._backend.start()
        log.info("CSI camera ready (picamera2) at %dx%d", width, height)

    def _init_usb(self, index, width, height):
        import cv2  # noqa: F401  (saves a local reference)
        self._cv2 = cv2
        cap = cv2.VideoCapture(int(index), cv2.CAP_V4L2)
        if not cap.isOpened():
            # Try the default backend as a last resort.
            cap = cv2.VideoCapture(int(index))
        if not cap.isOpened():
            raise RuntimeError(f"could not open USB camera at index {index}")
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, int(width))
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, int(height))
        self._backend = cap
        log.info("USB camera ready (cv2) at index %d, requested %dx%d",
                 int(index), width, height)

    def read(self):
        """Return an HxWx3 numpy array in RGB, or None if the read failed."""
        if self.kind == "csi":
            frame = self._backend.capture_array()
            # picamera2 with format RGB888 already returns RGB.
            return frame
        else:
            ok, frame = self._backend.read()
            if not ok or frame is None:
                return None
            # OpenCV returns BGR; convert so the rest of the pipeline can
            # treat both backends identically.
            return self._cv2.cvtColor(frame, self._cv2.COLOR_BGR2RGB)

    def close(self):
        if self._backend is None:
            return
        try:
            if self.kind == "csi":
                self._backend.stop()
                self._backend.close()
            else:
                self._backend.release()
        except Exception as e:
            log.warning("camera close error: %s", e)


def open_default():
    """Convenience entry-point that reads CAMERA_KIND / CAMERA_INDEX /
    CAMERA_WIDTH / CAMERA_HEIGHT from the environment."""
    return CameraSource(
        prefer=os.environ.get("CAMERA_KIND", "auto"),
        index=int(os.environ.get("CAMERA_INDEX", "0")),
        width=int(os.environ.get("CAMERA_WIDTH", "640")),
        height=int(os.environ.get("CAMERA_HEIGHT", "480")),
    )
