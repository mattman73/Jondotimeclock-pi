const express = require('express');
const ExcelJS = require('exceljs');
const { stringify: csvStringify } = require('csv-stringify/sync');
const reports = require('../services/reports');
const { todayYmd, addDays } = require('../services/timeUtils');

const router = express.Router();

// Default range = last 7 days, ending today.
function parseRange(req) {
    const today = todayYmd();
    const from = req.query.from || addDays(today, -7);
    const to = req.query.to || today;
    return { from, to };
}

const REPORT_DEFS = {
    daily: {
        title: 'Daily attendance',
        builder: reports.dailyAttendance,
        columns: [
            { key: 'day',         header: 'Date' },
            { key: 'displayname', header: 'Employee' },
            { key: 'empfullname', header: 'Username' },
            { key: 'firstIn',     header: 'First in' },
            { key: 'lastPunch',   header: 'Last punch' },
            { key: 'punchCount',  header: 'Punches' },
            { key: 'hours',       header: 'Hours' },
            { key: 'late',        header: 'Late by (min)' },
        ],
    },
    hours: {
        title: 'Hours per employee',
        builder: reports.hoursSummary,
        columns: [
            { key: 'displayname', header: 'Employee' },
            { key: 'empfullname', header: 'Username' },
            { key: 'days',        header: 'Days worked' },
            { key: 'hours',       header: 'Total hours' },
            { key: 'lateDays',    header: 'Days late' },
        ],
    },
    late: {
        title: 'Late arrivals & missed clock-ins',
        builder: reports.lateAndMissed,
        columns: [
            { key: 'day',         header: 'Date' },
            { key: 'displayname', header: 'Employee' },
            { key: 'empfullname', header: 'Username' },
            { key: 'expected',    header: 'Expected start' },
            { key: 'actual',      header: 'Actual in' },
            { key: 'minutesLate', header: 'Late by (min)' },
            { key: 'status',      header: 'Status' },
        ],
    },
    timeoff: {
        title: 'Time-off summary',
        builder: reports.timeOffSummary,
        columns: [
            { key: 'displayname',       header: 'Employee' },
            { key: 'empfullname',       header: 'Username' },
            { key: 'holidayApproved',   header: 'Holiday approved (h)' },
            { key: 'holidayPending',    header: 'Holiday pending (h)' },
            { key: 'sick',              header: 'Sick (h)' },
            { key: 'appointment',       header: 'Appointment (h)' },
            { key: 'compassionate',     header: 'Compassionate (h)' },
            { key: 'annualAllowance',   header: 'Annual allowance (h)' },
            { key: 'usedThisYear',      header: 'Used this year (h)' },
            { key: 'remainingThisYear', header: 'Remaining (h)' },
        ],
    },
};

router.get('/', (req, res) => {
    res.render('reports/index', {
        title: 'Reports',
        reports: Object.entries(REPORT_DEFS).map(([key, def]) => ({ key, title: def.title })),
    });
});

router.get('/:key', async (req, res, next) => {
    const def = REPORT_DEFS[req.params.key];
    if (!def) {
        req.flash('error', 'Unknown report.');
        return res.redirect('/reports');
    }
    try {
        const { from, to } = parseRange(req);
        const data = await def.builder(from, to);
        res.render('reports/run', {
            title: def.title,
            reportKey: req.params.key,
            from, to,
            columns: def.columns,
            data,
        });
    } catch (err) { next(err); }
});

router.get('/:key/export.xlsx', async (req, res, next) => {
    const def = REPORT_DEFS[req.params.key];
    if (!def) return res.status(404).send('Unknown report');
    try {
        const { from, to } = parseRange(req);
        const data = await def.builder(from, to);

        const wb = new ExcelJS.Workbook();
        wb.creator = 'Jondo Time Clock';
        const sheet = wb.addWorksheet(def.title.slice(0, 31));
        sheet.columns = def.columns.map(c => ({
            header: c.header, key: c.key, width: Math.max(c.header.length + 2, 14),
        }));
        sheet.getRow(1).font = { bold: true };
        for (const row of data) sheet.addRow(row);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition',
            `attachment; filename="jondo-${req.params.key}-${from}-to-${to}.xlsx"`);
        await wb.xlsx.write(res);
        res.end();
    } catch (err) { next(err); }
});

router.get('/:key/export.csv', async (req, res, next) => {
    const def = REPORT_DEFS[req.params.key];
    if (!def) return res.status(404).send('Unknown report');
    try {
        const { from, to } = parseRange(req);
        const data = await def.builder(from, to);
        const csv = csvStringify(data, {
            header: true,
            columns: def.columns.map(c => ({ key: c.key, header: c.header })),
        });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition',
            `attachment; filename="jondo-${req.params.key}-${from}-to-${to}.csv"`);
        res.send(csv);
    } catch (err) { next(err); }
});

module.exports = router;
