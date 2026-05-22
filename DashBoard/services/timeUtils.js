// Time helpers. The legacy schema stores all timestamps as Unix
// seconds (or millis for some rows — we coerce). Reports and the
// alert engine think in "local working day" terms, so most helpers
// here convert between epoch and local Y-M-D / H:M.

function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}

// Some installs of phpTimeclock store milliseconds, some seconds.
// Anything > 10^11 is treated as ms.
function normalizeStamp(stamp) {
    const n = Number(stamp);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}

function toDate(stamp) {
    return new Date(normalizeStamp(stamp) * 1000);
}

function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
}

// "YYYY-MM-DD" for a JS Date in the local timezone.
function ymd(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// "HH:MM" for a JS Date in the local timezone.
function hm(d) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Given "YYYY-MM-DD" + "HH:MM", build a local Date.
function buildLocal(dateStr, timeStr) {
    const [y, mo, da] = dateStr.split('-').map(Number);
    const [h, mi] = timeStr.split(':').map(Number);
    return new Date(y, mo - 1, da, h, mi, 0, 0);
}

// Returns the start-of-day Unix seconds for a "YYYY-MM-DD" in local time.
function startOfDayEpoch(dateStr) {
    return Math.floor(buildLocal(dateStr, '00:00').getTime() / 1000);
}

// End of day = next day's start - 1.
function endOfDayEpoch(dateStr) {
    const d = buildLocal(dateStr, '00:00');
    d.setDate(d.getDate() + 1);
    return Math.floor(d.getTime() / 1000) - 1;
}

// Monday=0..Sunday=6 (matches our 7-char workdays bitmask).
function workdayIndex(d) {
    const js = d.getDay(); // Sun=0..Sat=6
    return (js + 6) % 7;   // Mon=0..Sun=6
}

// Format Unix seconds as a friendly local string for tables.
function formatStamp(stamp) {
    if (!stamp) return '';
    const d = toDate(stamp);
    return `${ymd(d)} ${hm(d)}`;
}

// Today as YYYY-MM-DD in local time.
function todayYmd() {
    return ymd(new Date());
}

// Add `days` to a YYYY-MM-DD and return YYYY-MM-DD.
function addDays(dateStr, days) {
    const d = buildLocal(dateStr, '00:00');
    d.setDate(d.getDate() + days);
    return ymd(d);
}

// Difference in whole minutes between two HH:MM strings (b - a).
function diffMinutes(aHm, bHm) {
    const [ah, am] = aHm.split(':').map(Number);
    const [bh, bm] = bHm.split(':').map(Number);
    return (bh * 60 + bm) - (ah * 60 + am);
}

module.exports = {
    nowSeconds,
    normalizeStamp,
    toDate,
    ymd,
    hm,
    buildLocal,
    startOfDayEpoch,
    endOfDayEpoch,
    workdayIndex,
    formatStamp,
    todayYmd,
    addDays,
    diffMinutes,
    pad2,
};
