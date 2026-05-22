// Time-off rules & computations.
//
// Hours math:
//   For each calendar day the request touches, count the portion
//   that overlaps the configured working hours (e.g. 09:00-17:00 =
//   standard_workday_hours = 8). Saturdays/Sundays don't count.
//   Bank holidays / company shutdown days (non_working_days table)
//   also don't count. The result is then stored as `hours_requested`
//   on the row so historical accounting is stable even if you
//   change settings later.
//
// Overlap: a new request overlaps an existing approved request
// when [a.start, a.end] intersects [b.start, b.end] for the same
// employee.
//
// Notice: holiday requests must be submitted at least
// `min_holiday_notice_days` (alert_settings) before start_datetime.
// Other types have no notice rule.

const { query, t } = require('../db');

const REQUEST_TYPES = ['holiday', 'sick', 'appointment', 'compassionate'];

function isValidType(type) {
    return REQUEST_TYPES.includes(String(type || '').toLowerCase());
}

async function loadSettings() {
    const rows = await query(
        `SELECT min_holiday_notice_days, standard_workday_hours,
                timeoff_notify_email, manager_email
         FROM ${t('alert_settings')} WHERE id = 1`
    );
    return rows[0] || {
        min_holiday_notice_days: 14,
        standard_workday_hours: 8,
        timeoff_notify_email: '',
        manager_email: '',
    };
}

function parseLocalDateTime(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/);
    if (!m) return null;
    return new Date(
        Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4]), Number(m[5]), 0, 0
    );
}

function formatMysqlDateTime(d) {
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function workdayIndex(d) {
    return (d.getDay() + 6) % 7;
}

function ymdLocal(d) {
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// Fetch the set of non-working-day YYYY-MM-DD strings overlapping
// the given date range. Returned as a Set for O(1) lookup.
async function loadNonWorkingDays(startDate, endDate) {
    if (!startDate || !endDate) return new Set();
    const rows = await query(
        `SELECT DATE_FORMAT(holiday_date, '%Y-%m-%d') AS d
         FROM ${t('non_working_days')}
         WHERE holiday_date BETWEEN ? AND ?`,
        [ymdLocal(startDate), ymdLocal(endDate)]
    );
    return new Set(rows.map(r => r.d));
}

// Compute the requested hours for a [start, end] range. `skipDates`
// is an optional Set of YYYY-MM-DD strings that should be excluded
// (e.g. bank holidays loaded via loadNonWorkingDays).
function computeHours(startDate, endDate, workdayHours, skipDates) {
    if (!startDate || !endDate) return 0;
    if (endDate <= startDate) return 0;
    workdayHours = Number(workdayHours) || 8;
    const skip = skipDates || new Set();

    const MS = 60 * 60 * 1000;
    let hours = 0;
    let cur = new Date(startDate.getTime());
    while (cur < endDate) {
        const dow = workdayIndex(cur);
        const hr = cur.getHours();
        const onHoliday = skip.has(ymdLocal(cur));
        if (!onHoliday && dow < 5 && hr >= 9 && hr < (9 + workdayHours)) {
            const nextHourBoundary = new Date(cur.getTime());
            nextHourBoundary.setMinutes(0, 0, 0);
            nextHourBoundary.setHours(cur.getHours() + 1);
            const segmentEnd = endDate < nextHourBoundary ? endDate : nextHourBoundary;
            hours += (segmentEnd.getTime() - cur.getTime()) / MS;
            cur = segmentEnd;
        } else {
            const nextHourBoundary = new Date(cur.getTime());
            nextHourBoundary.setMinutes(0, 0, 0);
            nextHourBoundary.setHours(cur.getHours() + 1);
            cur = nextHourBoundary;
        }
    }
    return Math.round(hours * 100) / 100;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
}

async function findOverlap(empfullname, startDate, endDate, excludeId) {
    const startMy = formatMysqlDateTime(startDate);
    const endMy = formatMysqlDateTime(endDate);
    const rows = await query(
        `SELECT id, request_type, start_datetime, end_datetime, status
         FROM ${t('time_off_requests')}
         WHERE empfullname = ?
           AND status IN ('approved', 'pending')
           AND start_datetime < ?
           AND end_datetime   > ?`,
        [empfullname, endMy, startMy]
    );
    const conflicts = excludeId
        ? rows.filter(r => Number(r.id) !== Number(excludeId))
        : rows;
    return conflicts[0] || null;
}

async function computeRemainingAllowance(empfullname) {
    const empRows = await query(
        `SELECT holiday_allowance_hours FROM ${t('employees')}
         WHERE empfullname = ?`,
        [empfullname]
    );
    const allowance = empRows[0]
        ? Number(empRows[0].holiday_allowance_hours)
        : 0;

    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const yearStartMy = formatMysqlDateTime(yearStart);

    const used = await query(
        `SELECT COALESCE(SUM(hours_requested), 0) AS used
         FROM ${t('time_off_requests')}
         WHERE empfullname = ?
           AND request_type = 'holiday'
           AND status = 'approved'
           AND start_datetime >= ?`,
        [empfullname, yearStartMy]
    );
    const pending = await query(
        `SELECT COALESCE(SUM(hours_requested), 0) AS pending
         FROM ${t('time_off_requests')}
         WHERE empfullname = ?
           AND request_type = 'holiday'
           AND status = 'pending'
           AND start_datetime >= ?`,
        [empfullname, yearStartMy]
    );

    const usedHrs = Number(used[0].used);
    const pendingHrs = Number(pending[0].pending);
    return {
        allowance,
        used: usedHrs,
        pending: pendingHrs,
        remaining: allowance - usedHrs - pendingHrs,
        allowanceDays: Math.round((allowance / 8) * 10) / 10,
        usedDays: Math.round((usedHrs / 8) * 10) / 10,
        pendingDays: Math.round((pendingHrs / 8) * 10) / 10,
        remainingDays: Math.round(((allowance - usedHrs - pendingHrs) / 8) * 10) / 10,
    };
}

async function validateRequest(empfullname, type, startDate, endDate, settings) {
    if (!isValidType(type)) {
        return { ok: false, reason: 'Unknown request type.' };
    }
    if (!startDate || !endDate) {
        return { ok: false, reason: 'Start and end date/time are required.' };
    }
    if (endDate <= startDate) {
        return { ok: false, reason: 'End must be after start.' };
    }
    if (type === 'holiday') {
        const noticeDays = Number(settings.min_holiday_notice_days) || 0;
        const earliestAllowed = new Date();
        earliestAllowed.setDate(earliestAllowed.getDate() + noticeDays);
        if (startDate < earliestAllowed) {
            return {
                ok: false,
                reason: `Holiday must be requested at least ${noticeDays} days in advance.`,
            };
        }
    }
    const conflict = await findOverlap(empfullname, startDate, endDate);
    if (conflict) {
        return {
            ok: false,
            reason: `Overlaps an existing ${conflict.status} ${conflict.request_type} request (${conflict.start_datetime} – ${conflict.end_datetime}).`,
        };
    }
    if (type === 'holiday') {
        const skip = await loadNonWorkingDays(startDate, endDate);
        const hrs = computeHours(startDate, endDate, settings.standard_workday_hours, skip);
        const a = await computeRemainingAllowance(empfullname);
        if (hrs > a.remaining) {
            return {
                ok: false,
                reason: `This request needs ${hrs.toFixed(1)}h but only ${a.remaining.toFixed(1)}h are left in your allowance.`,
            };
        }
    }
    return { ok: true };
}

module.exports = {
    REQUEST_TYPES,
    isValidType,
    loadSettings,
    loadNonWorkingDays,
    parseLocalDateTime,
    formatMysqlDateTime,
    computeHours,
    rangesOverlap,
    findOverlap,
    computeRemainingAllowance,
    validateRequest,
};
