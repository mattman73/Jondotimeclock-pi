// Decides whether the kiosk camera / face scanner should be awake
// right now.
//
// When the schedule is enabled there are two daily windows — a
// morning window and an evening window — and the camera sleeps
// outside both. A manual "wake" tap on the kiosk sets
// camera_wake_until (epoch seconds); while that deadline is in the
// future the camera stays awake regardless of the windows.
//
// Both the kiosk page and the Pi-facing API use this one function
// so they always agree.

// "HH:MM" -> minutes since midnight, or null if malformed.
function hhmmToMinutes(s) {
    if (typeof s !== 'string') return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
}

// Is nowMin (minutes since midnight) inside [on, off)?
// Handles a window that wraps past midnight (on > off).
function inWindow(nowMin, on, off) {
    if (on == null || off == null || on === off) return false;
    if (on < off) return nowMin >= on && nowMin < off;
    return nowMin >= on || nowMin < off;   // wraps midnight
}

// settings: a row from alert_settings. now: a Date (defaults now).
// Returns { active, scheduleEnabled, reason, wakeUntil?, wakeSecondsLeft? }
function computeCameraState(settings, now = new Date()) {
    const s = settings || {};

    // Schedule off (or columns not migrated yet) -> always awake.
    if (!Number(s.camera_schedule_enabled)) {
        return { active: true, scheduleEnabled: false, reason: 'schedule-off' };
    }

    const nowMin = now.getHours() * 60 + now.getMinutes();
    const nowEpoch = Math.floor(now.getTime() / 1000);

    const inMorning = inWindow(nowMin,
        hhmmToMinutes(s.camera_morning_on), hhmmToMinutes(s.camera_morning_off));
    const inEvening = inWindow(nowMin,
        hhmmToMinutes(s.camera_evening_on), hhmmToMinutes(s.camera_evening_off));

    if (inMorning || inEvening) {
        return { active: true, scheduleEnabled: true, reason: 'scheduled' };
    }

    // Outside both windows — honour a manual wake override.
    const wakeUntil = Number(s.camera_wake_until) || 0;
    if (wakeUntil && nowEpoch < wakeUntil) {
        return {
            active: true,
            scheduleEnabled: true,
            reason: 'awake-override',
            wakeUntil,
            wakeSecondsLeft: wakeUntil - nowEpoch,
        };
    }

    return { active: false, scheduleEnabled: true, reason: 'asleep' };
}

module.exports = { computeCameraState, hhmmToMinutes, inWindow };
