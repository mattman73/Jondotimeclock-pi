// Report builders. Each returns a plain JS object you can hand
// straight to a view OR to an Excel/CSV exporter.

const { query, t } = require('../db');
const {
    startOfDayEpoch, endOfDayEpoch, normalizeStamp, hm, ymd, toDate,
    buildLocal, addDays,
} = require('./timeUtils');

// Daily attendance: one row per (employee, day) within the range.
async function dailyAttendance(fromDate, toDate_) {
    const startEpoch = startOfDayEpoch(fromDate);
    const endEpoch = endOfDayEpoch(toDate_);

    const punches = await query(
        `SELECT fullname, \`inout\`, timestamp
         FROM ${t('info')}
         WHERE timestamp BETWEEN ? AND ?
         ORDER BY fullname, timestamp ASC`,
        [startEpoch, endEpoch]
    );

    const employees = await query(
        `SELECT e.empfullname, e.displayname,
                s.shift_start, s.shift_end, s.workdays, s.grace_minutes
         FROM ${t('employees')} e
         LEFT JOIN ${t('schedules')} s ON s.empfullname = e.empfullname
         WHERE e.disabled = 0`,
        []
    );
    const empMap = new Map(employees.map(e => [e.empfullname, e]));

    const buckets = new Map();
    for (const p of punches) {
        const d = toDate(p.timestamp);
        const day = ymd(d);
        const key = `${p.fullname}|${day}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(p);
    }

    const out = [];
    for (const [key, list] of buckets) {
        const [emp, day] = key.split('|');
        const empInfo = empMap.get(emp) || { displayname: emp };
        const firstIn = list.find(p => p.inout === 'in');
        const last = list[list.length - 1];

        let totalMinutes = 0;
        let openIn = null;
        for (const p of list) {
            const tEpoch = normalizeStamp(p.timestamp);
            if (p.inout === 'in') {
                openIn = tEpoch;
            } else if (openIn != null) {
                totalMinutes += Math.max(0, Math.round((tEpoch - openIn) / 60));
                openIn = null;
            }
        }

        let lateMinutes = null;
        if (firstIn && empInfo.shift_start) {
            const expected = buildLocal(day, empInfo.shift_start);
            lateMinutes = Math.round((toDate(firstIn.timestamp) - expected) / 60000);
        }

        out.push({
            day,
            empfullname: emp,
            displayname: empInfo.displayname || emp,
            firstIn: firstIn ? hm(toDate(firstIn.timestamp)) : '',
            lastPunch: last ? `${last.inout} ${hm(toDate(last.timestamp))}` : '',
            punchCount: list.length,
            hours: (totalMinutes / 60).toFixed(2),
            late: lateMinutes != null && lateMinutes > 0 ? lateMinutes : '',
        });
    }

    out.sort((a, b) => a.day.localeCompare(b.day) || a.displayname.localeCompare(b.displayname));
    return out;
}

async function hoursSummary(fromDate, toDate_) {
    const detail = await dailyAttendance(fromDate, toDate_);
    const totals = new Map();
    for (const row of detail) {
        const key = row.empfullname;
        if (!totals.has(key)) {
            totals.set(key, {
                empfullname: key,
                displayname: row.displayname,
                days: 0,
                hours: 0,
                lateDays: 0,
            });
        }
        const t_ = totals.get(key);
        t_.days += 1;
        t_.hours += parseFloat(row.hours);
        if (row.late && Number(row.late) > 0) t_.lateDays += 1;
    }
    return Array.from(totals.values())
        .map(r => ({ ...r, hours: r.hours.toFixed(2) }))
        .sort((a, b) => a.displayname.localeCompare(b.displayname));
}

async function lateAndMissed(fromDate, toDate_) {
    const employees = await query(
        `SELECT e.empfullname, e.displayname,
                s.shift_start, s.workdays, s.grace_minutes
         FROM ${t('employees')} e
         JOIN ${t('schedules')} s ON s.empfullname = e.empfullname
         WHERE e.disabled = 0 AND s.active = 1`,
        []
    );

    const startEpoch = startOfDayEpoch(fromDate);
    const endEpoch = endOfDayEpoch(toDate_);
    const punches = await query(
        `SELECT fullname, \`inout\`, timestamp
         FROM ${t('info')}
         WHERE timestamp BETWEEN ? AND ? AND \`inout\` = 'in'
         ORDER BY fullname, timestamp ASC`,
        [startEpoch, endEpoch]
    );

    const firstInBy = new Map();
    for (const p of punches) {
        const day = ymd(toDate(p.timestamp));
        const key = `${p.fullname}|${day}`;
        if (!firstInBy.has(key)) firstInBy.set(key, p);
    }

    const today = ymd(new Date());
    const out = [];
    for (const emp of employees) {
        const wd = (emp.workdays || '0000000').padEnd(7, '0');
        let day = fromDate;
        while (day <= toDate_) {
            const d = buildLocal(day, '00:00');
            const dow = (d.getDay() + 6) % 7;
            if (wd[dow] === '1' && day <= today) {
                const key = `${emp.empfullname}|${day}`;
                const punch = firstInBy.get(key);
                if (!punch) {
                    out.push({
                        day, empfullname: emp.empfullname, displayname: emp.displayname || emp.empfullname,
                        expected: emp.shift_start, actual: '', minutesLate: '', status: 'NO CLOCK-IN',
                    });
                } else {
                    const expected = buildLocal(day, emp.shift_start);
                    const minutesLate = Math.round((toDate(punch.timestamp) - expected) / 60000);
                    if (minutesLate > emp.grace_minutes) {
                        out.push({
                            day, empfullname: emp.empfullname, displayname: emp.displayname || emp.empfullname,
                            expected: emp.shift_start, actual: hm(toDate(punch.timestamp)),
                            minutesLate, status: 'LATE',
                        });
                    }
                }
            }
            day = addDays(day, 1);
        }
    }
    out.sort((a, b) => b.day.localeCompare(a.day) || a.displayname.localeCompare(b.displayname));
    return out;
}

// Time-off summary: per-employee approved/pending hours within the
// date range, plus their total annual allowance and what's left.
async function timeOffSummary(fromDate, toDate_) {
    const employees = await query(
        `SELECT empfullname, displayname, holiday_allowance_hours
         FROM ${t('employees')}
         WHERE disabled = 0
         ORDER BY displayname, empfullname`,
        []
    );

    const rows = await query(
        `SELECT empfullname, request_type, status, hours_requested,
                start_datetime, end_datetime
         FROM ${t('time_off_requests')}
         WHERE DATE(start_datetime) <= ?
           AND DATE(end_datetime)   >= ?`,
        [toDate_, fromDate]
    );

    const byEmp = new Map();
    for (const r of rows) {
        if (!byEmp.has(r.empfullname)) byEmp.set(r.empfullname, []);
        byEmp.get(r.empfullname).push(r);
    }

    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const yearStartYmd = ymd(yearStart);
    const yearUsed = await query(
        `SELECT empfullname, COALESCE(SUM(hours_requested), 0) AS used
         FROM ${t('time_off_requests')}
         WHERE request_type = 'holiday'
           AND status = 'approved'
           AND DATE(start_datetime) >= ?
         GROUP BY empfullname`,
        [yearStartYmd]
    );
    const usedMap = new Map(yearUsed.map(r => [r.empfullname, Number(r.used)]));

    const out = [];
    for (const emp of employees) {
        const list = byEmp.get(emp.empfullname) || [];
        const inRange = {
            holidayApproved: 0, holidayPending: 0,
            sick: 0, appointment: 0, compassionate: 0,
        };
        for (const r of list) {
            const hrs = Number(r.hours_requested);
            if (r.request_type === 'holiday') {
                if (r.status === 'approved') inRange.holidayApproved += hrs;
                else if (r.status === 'pending') inRange.holidayPending += hrs;
            } else if (r.status === 'approved') {
                if (r.request_type === 'sick') inRange.sick += hrs;
                else if (r.request_type === 'appointment') inRange.appointment += hrs;
                else if (r.request_type === 'compassionate') inRange.compassionate += hrs;
            }
        }
        const allowance = Number(emp.holiday_allowance_hours || 0);
        const usedYearTotal = usedMap.get(emp.empfullname) || 0;
        const remaining = allowance - usedYearTotal;

        out.push({
            empfullname: emp.empfullname,
            displayname: emp.displayname || emp.empfullname,
            holidayApproved: inRange.holidayApproved.toFixed(2),
            holidayPending: inRange.holidayPending.toFixed(2),
            sick: inRange.sick.toFixed(2),
            appointment: inRange.appointment.toFixed(2),
            compassionate: inRange.compassionate.toFixed(2),
            annualAllowance: allowance.toFixed(2),
            usedThisYear: usedYearTotal.toFixed(2),
            remainingThisYear: remaining.toFixed(2),
        });
    }
    return out;
}

module.exports = { dailyAttendance, hoursSummary, lateAndMissed, timeOffSummary };
