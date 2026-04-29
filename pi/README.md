# Jondo Time Clock — Pi face-recognition scanner

A small Python service that runs on a Raspberry Pi, watches a
camera, and clocks people in / out by face. It calls the dashboard's
`/api/punch` endpoint over HTTP — same effect as a barcode scan.

## What it does and doesn't do

It does:
- Pulls reference photos from the dashboard for every employee
  with `face_opt_in = 1`, and computes 128-d face embeddings
  locally (using dlib via the `face_recognition` library).
- Watches the camera, detects faces, matches against the cache.
- Only acts when the match is confident (low distance) AND the
  same person has been the dominant subject for at least
  `MIN_HOLD_SEC` seconds.
- Won't punch the same person twice within `COOLDOWN_SEC` seconds.
- Reports every match attempt back to the dashboard's audit log
  so admins can debug confidence thresholds.

It doesn't:
- Anti-spoofing. A photo on a phone screen will fool it. If you
  need liveness detection, that's a follow-up project — see
  `Silent-Face-Anti-Spoofing` or use a depth camera (Intel
  RealSense) and add a depth check.
- Train its own model. It uses the dlib pre-trained 128-d face
  recognition model.

## Hardware

- Raspberry Pi 4 (4GB+) or Pi 5. Pi Zero 2 W is too slow.
- A camera. Any of:
  - Pi Camera Module 3 (CSI ribbon) — best image quality.
  - Logitech C920 / similar USB webcam — easiest to set up.
- A small ring-light or under-monitor light if your kiosk spot is
  poorly lit. Lighting is the #1 cause of misidentifications.

## One-time install on the Pi

```bash
sudo apt update
sudo apt install -y python3-venv python3-pip cmake build-essential \
                    libopenblas-dev liblapack-dev libjpeg-dev \
                    libv4l-dev libsm6 libxext6 libxrender1
cd /home/pi
git clone <your repo>  # or copy the dashboard/pi folder here
cd <project>/dashboard/pi
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# edit .env: set BASE_URL and API_TOKEN
```

`pip install face_recognition` will compile dlib — that takes
~15–20 minutes on a Pi 4. Don't worry about it.

To check the camera works:
```bash
python -c "import cv2; cap=cv2.VideoCapture(0); ok,f=cap.read(); print('frame', f.shape if ok else 'FAILED')"
```

## Running

```bash
cd /home/pi/<project>/dashboard/pi
source venv/bin/activate
python scanner.py
```

You should see something like:
```
2026-04-29 09:12:01 pi.scanner INFO initial sync from http://… …
2026-04-29 09:12:03 pi.sync   INFO Cache loaded: 6 photos, 6 embeddings, 2 distinct people
2026-04-29 09:12:03 pi.scanner INFO scanner running (threshold=0.50, hold=1.5s, cooldown=60s)
```

Walk in front of the camera. After ~1.5s of holding still you
should see `PUNCH OK: <name> -> in` and the dashboard board will
light up.

## Tuning

Open the dashboard's **Faces → manage** page for an employee — the
"Recent match attempts" section shows you every match the Pi
considered, with the confidence. Use that to dial in:

- **Too many false positives** (people getting punched as the
  wrong person) → lower `MATCH_THRESHOLD` (try 0.45, then 0.40).
- **Too many `rejected: no match within threshold`** (real people
  not getting recognised) → raise `MATCH_THRESHOLD` slightly
  (0.55), capture a couple more reference photos, or improve
  lighting.
- **Same person punching back-and-forth in a single visit** →
  raise `COOLDOWN_SEC`.
- **Slow on Pi 4** → drop `FRAME_SCALE` to 0.4 or 0.33.

## Run as a service (systemd)

```ini
# /etc/systemd/system/jondo-face.service
[Unit]
Description=Jondo Time Clock face scanner
After=network-online.target

[Service]
User=pi
WorkingDirectory=/home/pi/jondo-time-clock/dashboard/pi
ExecStart=/home/pi/jondo-time-clock/dashboard/pi/venv/bin/python scanner.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now jondo-face.service
journalctl -u jondo-face.service -f
```

## Compliance notes (UK GDPR)

You **must** have explicit, freely-given, written consent from each
employee whose face is enrolled. The `Faces` page in the dashboard
records the consent timestamp; that's evidence. Make sure:

1. Consent is opt-in — the **Opt in** button is OFF by default.
2. There's a non-biometric alternative (badge / password) and
   it's actually offered, not buried.
3. You've done a Data Protection Impact Assessment for it.
4. The "Erase all face data" button on each employee's Faces page
   actually works (it does — it soft-deletes photos and removes
   audit history). Test it before promising it to a real person.

If you're not ready to tick those boxes yet, leave `face_opt_in` =
0 for everyone. The Pi will refuse to match against anyone who
isn't opted in, so no biometric data is processed.
