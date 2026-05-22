// Today's status board. Shows for every active employee:
//   - their expected start (if scheduled)
//   - their current state (in / out / break / lunch / not-yet)
//   - lateness in minutes
//   - any unresolved alerts
//
// Plus three side panels:
//   - Team away today (approved time-off covering today)
//   - Upcoming approved leave (next 14 days)
//   - Recent activity (last 20 punches today)

const express = require('express');
const { query, t } = require('../db');
const {
    todayYmd, startOfDayEpoch, endOfDayEpoch,
    formatStamp, normalizeStamp, hm, toDate, workdayIndex, buildLocal,
} = require('../services/timeUtils');

const router = express.Router();

router.get('/', async (req, res, next) => {
    try {
        const today = todayYmd();
        const startEpoch = startOfDayEpoch(today);
        const endEpoch = endOfDayEpoch(today);

        // 1. All active employees + their schedule (LEFT JOIN — schedule optional).
        const employees = await query(
            `SELECT e.empfullname, e.displayname, e.email,
                    s.shift_start, s.shift_end, s.workdays, s.grace_minutes,
                    s.active AS schedule_active
             FROM ${t('employees')} e
             LEFT JOIN ${t('schedules')} s ON s.empfullname = e.empfullname
             WHERE e.disabled = 0
             ORDER BY e.displayname, e.empfullname`,
            []
        );

        // 2. All today's punches in one shot.
        const punches = await query(
            `SELECT fullname, \`inout\`, timestamp
             FROM ${t('info')}
             WHERE timestamp BETWEEN ? AND ?
             ORDER BY timestamp ASC`,
            [startEpoch, endEpoch]
        );

        // 3. Unresolved alerts for today.
        const alerts = await query(
            `SELECT empfullname, expected_start, minutes_late, manager_emailed, employee_emailed
             FROM ${t('alerts_log')}
             WHERE alert_date = ? AND resolved_at IS NULL`,
            [today]
        );
        const alertByEmp = new Map(alerts.map(a => [a.empfullname, a]));

        // Group punches by employee, latest last.
        const punchesByEmp = new Map();
        for (const p of punches) {
            if (!punchesByEmp.has(p.fullname)) punchesByEmp.set(p.fullname, []);
            punchesByEmp.get(p.fullname).push(p);
        }

        const todayDate = new Date();
        const todayWorkday = workdayIndex(todayDate);

        const rows = employees.map(emp => {
            const list = punchesByEmp.get(emp.empfullname) || [];
            const last = list[list.length - 1];
            const firstIn = list.find(p => p.inout === 'in');

            const isWorkdayToday = !!emp.workdays && emp.workdays[todayWorkday] === '1';
            const scheduled = !!emp.shift_start && Number(emp.schedule_active) === 1 && isWorkdayToday;

            let status = 'Not yet';
            let statusClass = 'muted';
            if (last) {
                status = last.inout.charAt(0).toUpperCase() + last.inout.slice(1);
                statusClass = last.inout === 'in' ? 'good'
                            : last.inout === 'out' ? 'muted'
                            : 'warn';
            }

            let firstInDisplay = '';
            let minutesLate = null;
            if (firstIn) {
                firstInDisplay = hm(toDate(firstIn.timestamp));
                if (scheduled) {
                    const expected = buildLocal(todayYmd(), emp.shift_start);
                    const actual = toDate(firstIn.timestamp);
                    const diff = Math.round((actual - expected) / 60000);
                    if (diff > 0) minutesLate = diff;
                }
            } else if (scheduled) {
                const expected = buildLocal(todayYmd(), emp.shift_start);
                const diff = Math.round((Date.now() - expected.getTime()) / 60000);
                if (diff > 0) minutesLate = diff;
            }

            const alert = alertByEmp.get(emp.empfullname) || null;

            return {
                empfullname: emp.empfullname,
                displayname: emp.displayname || emp.empfullname,
                scheduled,
                shift_start: emp.shift_start || '',
                shift_end: emp.shift_end || '',
                grace_minutes: emp.grace_minutes,
                status,
                statusClass,
                firstIn: firstInDisplay,
                minutesLate,
                alert,
            };
        });

        rows.sort((a, b) => {
            if (!!a.alert !== !!b.alert) return a.alert ? -1 : 1;
            const aLate = a.minutesLate || 0;
            const bLate = b.minutesLate || 0;
            if (aLate !== bLate) return bLate - aLate;
            return a.displayname.localeCompare(b.displayname);
        });

        const recent = punches.slice(-20).reverse().map(p => ({
            fullname: p.fullname,
            inout: p.inout,
            when: formatStamp(p.timestamp),
        }));

        // Team away today
        const awayToday = await query(
            `SELECT r.empfullname, e.displayname, r.request_type,
                    r.start_datetime, r.end_datetime
             FROM ${t('time_off_requests')} r
             JOIN ${t('employees')} e ON e.empfullname = r.empfullname
             WHERE r.status = 'approved'
               AND DATE(r.start_datetime) <= ?
               AND DATE(r.end_datetime)   >= ?
             ORDER BY r.request_type, e.displayname`,
            [today, today]
        );
        const holidayToday = await query(
            `SELECT label FROM ${t('non_working_days')} WHERE holiday_date = ?`,
            [today]
        );
        const todayHoliday = holidayToday.length
            ? (holidayToday[0].label || 'Non-working day')
            : null;

        // Upcoming approved leave — next 14 days
        function pad(n) { return n < 10 ? '0' + n : '' + n; }
        const u = new Date();
        u.setDate(u.getDate() + 14);
        const upcomingEndYmd = u.getFullYear() + '-' + pad(u.getMonth() + 1) + '-' + pad(u.getDate());
        const upcoming = await query(
            `SELECT r.empfullname, e.displayname, r.request_type,
                    r.start_datetime, r.end_datetime
             FROM ${t('time_off_requests')} r
             JOIN ${t('employees')} e ON e.empfullname = r.empfullname
             WHERE r.status = 'approved'
               AND DATE(r.start_datetime) > ?
               AND DATE(r.start_datetime) <= ?
             ORDER BY r.start_datetime ASC
             LIMIT 10`,
            [today, upcomingEndYmd]
        );

        const counts = {
            total: rows.length,
            in: rows.filter(r => r.status === 'In').length,
            out: rows.filter(r => r.status === 'Out').length,
            onBreak: rows.filter(r => r.status === 'Break' || r.status === 'Lunch').length,
            notYet: rows.filter(r => r.status === 'Not yet').length,
            late: rows.filter(r => !!r.alert).length,
            away: awayToday.length,
        };

        res.render('dashboard', {
            title: 'Dashboard',
            today,
            rows,
            recent,
            counts,
            awayToday,
            todayHoliday,
            upcoming,
        });
    } catch (err) {
        next(err);
    }
});

// Manually mark an alert as resolved (e.g. employee called in sick).
router.post('/alerts/:id/resolve', async (req, res, next) => {
    try {
        await query(
            `UPDATE ${t('alerts_log')} SET resolved_at = NOW() WHERE id = ?`,
            [req.params.id]
        );
        req.flash('success', 'Alert marked resolved.');
        res.redirect('/dashboard');
    } catch (err) { next(err); }
});

module.exports = router;
