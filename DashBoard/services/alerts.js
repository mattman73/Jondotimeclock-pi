// Late-arrival alert engine.
//
// Runs on a cron schedule (default: every minute). For each
// scheduled, active employee whose shift started > grace minutes
// ago today, checks whether they have an "in" punch yet today. If
// not, AND they're not on approved time off, AND today isn't a
// company-wide non-working day, AND we haven't already alerted
// today, write an alerts_log row and send the configured emails.

const cron = require('node-cron');
const { query, t } = require('../db');
const { sendMail, loadSettings } = require('./mailer');
const { sendWhatsApp } = require('./whatsapp');
const {
    todayYmd, startOfDayEpoch, endOfDayEpoch, buildLocal, workdayIndex,
} = require('./timeUtils');

async function runOnce() {
    const today = todayYmd();
    const now = new Date();
    const todayDow = workdayIndex(now);

    // Company-wide non-working day? If today is a bank holiday /
    // shutdown day, nobody is expected in and no alerts fire.
    const holidayRows = await query(
        `SELECT label FROM ${t('non_working_days')}
         WHERE holiday_date = ? LIMIT 1`,
        [today]
    );
    if (holidayRows.length) {
        console.log(`[alerts] today (${today}) is a non-working day (${holidayRows[0].label || ''}) — skipping run`);
        return { checked: 0, alerted: 0, skipped: 'non_working_day' };
    }

    const employees = await query(
        `SELECT e.empfullname, e.displayname, e.email,
                s.shift_start, s.workdays, s.grace_minutes
         FROM ${t('employees')} e
         JOIN ${t('schedules')} s ON s.empfullname = e.empfullname
         WHERE e.disabled = 0 AND s.active = 1`,
        []
    );
    if (!employees.length) return { checked: 0, alerted: 0 };

    // Today's "in" punches in one query.
    const punches = await query(
        `SELECT fullname FROM ${t('info')}
         WHERE \`inout\` = 'in' AND timestamp BETWEEN ? AND ?`,
        [startOfDayEpoch(today), endOfDayEpoch(today)]
    );
    const clockedIn = new Set(punches.map(p => p.fullname));

    // Already-alerted today
    const existing = await query(
        `SELECT empfullname FROM ${t('alerts_log')} WHERE alert_date = ?`,
        [today]
    );
    const alreadyAlerted = new Set(existing.map(r => r.empfullname));

    // Employees on approved time off covering today
    const onLeaveRows = await query(
        `SELECT empfullname FROM ${t('time_off_requests')}
         WHERE status = 'approved'
           AND DATE(start_datetime) <= ?
           AND DATE(end_datetime)   >= ?`,
        [today, today]
    );
    const onLeave = new Set(onLeaveRows.map(r => r.empfullname));

    const settings = await loadSettings();
    let alerted = 0;

    for (const emp of employees) {
        const wd = (emp.workdays || '0000000').padEnd(7, '0');
        if (wd[todayDow] !== '1') continue;                 // not a workday
        if (onLeave.has(emp.empfullname)) continue;         // on approved leave
        if (clockedIn.has(emp.empfullname)) continue;       // already in
        if (alreadyAlerted.has(emp.empfullname)) continue;  // already alerted today

        const expected = buildLocal(today, emp.shift_start);
        const minutesPast = Math.round((now - expected) / 60000);
        if (minutesPast <= emp.grace_minutes) continue;     // still within grace

        // Insert alert log row first (UNIQUE key prevents races).
        try {
            await query(
                `INSERT INTO ${t('alerts_log')}
                    (empfullname, alert_date, expected_start, minutes_late)
                 VALUES (?, ?, ?, ?)`,
                [emp.empfullname, today, emp.shift_start, minutesPast]
            );
        } catch (e) {
            if (e.code === 'ER_DUP_ENTRY') continue;
            throw e;
        }

        let managerSent = 0, employeeSent = 0;
        const subject = `[Jondo] ${emp.displayname || emp.empfullname} hasn't clocked in (${minutesPast} min late)`;
        const body =
`${emp.displayname || emp.empfullname} was scheduled to start at ${emp.shift_start} today (${today})
and has not yet clocked in. Currently ${minutesPast} minutes past the expected start time.

Open the dashboard: http://localhost:${process.env.PORT || 3000}/dashboard`;

        if (settings && Number(settings.notify_manager) && settings.manager_email) {
            const r = await sendMail({ to: settings.manager_email, subject, text: body });
            managerSent = r.sent ? 1 : 0;
        }
        // WhatsApp the managers too (runs alongside email; self-gated
        // by the whatsapp_enabled setting, so harmless if unused).
        try {
            await sendWhatsApp(
                `${emp.displayname || emp.empfullname} has not clocked in `
                + `— ${minutesPast} min past their ${emp.shift_start} start (${today}).`,
                settings
            );
        } catch (e) {
            console.error('[alerts] whatsapp:', e.message);
        }
        if (settings && Number(settings.notify_employee) && emp.email) {
            const empSubject = `Reminder: please clock in (${minutesPast} min past your start time)`;
            const empBody =
`Hi ${emp.displayname || emp.empfullname},

Our records show you haven't clocked in yet today. Your shift started at ${emp.shift_start}.
If you're already on site, please clock in. If you'll be absent, please notify your manager.

— Jondo Time Clock`;
            const r = await sendMail({ to: emp.email, subject: empSubject, text: empBody });
            employeeSent = r.sent ? 1 : 0;
        }

        await query(
            `UPDATE ${t('alerts_log')}
             SET manager_emailed = ?, employee_emailed = ?
             WHERE empfullname = ? AND alert_date = ?`,
            [managerSent, employeeSent, emp.empfullname, today]
        );

        alerted += 1;
        console.log(`[alerts] ${emp.empfullname} flagged late (${minutesPast}m, manager=${managerSent}, employee=${employeeSent})`);
    }
    return { checked: employees.length, alerted };
}

let task = null;

function startAlertEngine() {
    const expr = process.env.ALERT_CRON || '* * * * *';
    if (!cron.validate(expr)) {
        console.error(`[alerts] invalid ALERT_CRON "${expr}", using default "* * * * *"`);
    }
    const useExpr = cron.validate(expr) ? expr : '* * * * *';
    task = cron.schedule(useExpr, () => {
        runOnce().catch(err => console.error('[alerts] tick error:', err.message));
    });
    console.log(`[alerts] engine started (cron "${useExpr}")`);
}

function stopAlertEngine() {
    if (task) task.stop();
}

module.exports = { startAlertEngine, stopAlertEngine, runOnce };
