// Staff management. Reads/writes the legacy `employees` table so
// every change is immediately visible to the PHP clock-in app.

const express = require('express');
const { query, t } = require('../db');
const { hashPassword, requireAdmin } = require('../services/auth');

const router = express.Router();

// All staff actions require an admin (or time_admin) account.
router.use(requireAdmin);

// LIST
router.get('/', async (req, res, next) => {
    try {
        const showDisabled = req.query.show === 'all';
        const rows = await query(
            `SELECT e.empfullname, e.displayname, e.email, e.\`groups\`, e.office,
                    e.employees_BadgeID,
                    e.admin, e.reports, e.time_admin, e.disabled,
                    s.shift_start, s.shift_end
             FROM ${t('employees')} e
             LEFT JOIN ${t('schedules')} s ON s.empfullname = e.empfullname
             ${showDisabled ? '' : 'WHERE e.disabled = 0'}
             ORDER BY e.disabled, e.displayname, e.empfullname`,
            []
        );
        res.render('staff/list', {
            title: 'Staff',
            rows,
            showDisabled,
        });
    } catch (err) { next(err); }
});

// NEW form
router.get('/new', (req, res) => {
    res.render('staff/form', {
        title: 'Add staff',
        emp: { empfullname: '', displayname: '', email: '', groups: '', office: '',
               employees_BadgeID: '',
               admin: 0, reports: 0, time_admin: 0, disabled: 0 },
        isNew: true,
    });
});

// CREATE
router.post('/new', async (req, res, next) => {
    const { empfullname, displayname, email, groups, office, password,
            employees_BadgeID, admin, reports, time_admin } = req.body;
    try {
        if (!empfullname || !password) {
            req.flash('error', 'Username and initial password are required.');
            return res.redirect('/staff/new');
        }
        const exists = await query(
            `SELECT 1 FROM ${t('employees')} WHERE empfullname = ?`,
            [empfullname]
        );
        if (exists.length) {
            req.flash('error', `Username "${empfullname}" already exists.`);
            return res.redirect('/staff/new');
        }
        // Reject duplicate badge IDs — they'd cause the kiosk to punch
        // the wrong person.
        if (employees_BadgeID && employees_BadgeID.trim()) {
            const dup = await query(
                `SELECT empfullname FROM ${t('employees')}
                 WHERE employees_BadgeID = ? LIMIT 1`,
                [employees_BadgeID.trim()]
            );
            if (dup.length) {
                req.flash('error', `Badge ID "${employees_BadgeID}" is already assigned to ${dup[0].empfullname}.`);
                return res.redirect('/staff/new');
            }
        }
        await query(
            `INSERT INTO ${t('employees')}
             (empfullname, employee_passwd, displayname, email, \`groups\`, office,
              employees_BadgeID,
              admin, reports, time_admin, disabled)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
            [
                empfullname,
                hashPassword(password),
                displayname || empfullname,
                email || '',
                groups || '',
                office || '',
                (employees_BadgeID || '').trim(),
                admin ? 1 : 0,
                reports ? 1 : 0,
                time_admin ? 1 : 0,
            ]
        );
        req.flash('success', `Added ${empfullname}.`);
        res.redirect('/staff');
    } catch (err) { next(err); }
});

// EDIT form
router.get('/:empfullname/edit', async (req, res, next) => {
    try {
        const rows = await query(
            `SELECT empfullname, displayname, email, \`groups\`, office,
                    employees_BadgeID, holiday_allowance_hours,
                    admin, reports, time_admin, disabled
             FROM ${t('employees')} WHERE empfullname = ?`,
            [req.params.empfullname]
        );
        if (!rows.length) {
            req.flash('error', 'Staff member not found.');
            return res.redirect('/staff');
        }
        res.render('staff/form', {
            title: 'Edit staff',
            emp: rows[0],
            isNew: false,
        });
    } catch (err) { next(err); }
});

// UPDATE
router.post('/:empfullname/edit', async (req, res, next) => {
    const { displayname, email, groups, office, password,
            employees_BadgeID, holiday_allowance_hours,
            admin, reports, time_admin, disabled } = req.body;
    try {
        // Guard against assigning the same badge to two employees.
        const newBadge = (employees_BadgeID || '').trim();
        if (newBadge) {
            const dup = await query(
                `SELECT empfullname FROM ${t('employees')}
                 WHERE employees_BadgeID = ? AND empfullname <> ?
                 LIMIT 1`,
                [newBadge, req.params.empfullname]
            );
            if (dup.length) {
                req.flash('error', `Badge ID "${newBadge}" is already assigned to ${dup[0].empfullname}.`);
                return res.redirect(`/staff/${encodeURIComponent(req.params.empfullname)}/edit`);
            }
        }

        const fields = [
            'displayname = ?', 'email = ?', '`groups` = ?', 'office = ?',
            'employees_BadgeID = ?', 'holiday_allowance_hours = ?',
            'admin = ?', 'reports = ?', 'time_admin = ?', 'disabled = ?',
        ];
        // Parse the allowance value defensively. Empty / non-numeric
        // leaves the existing value (we re-read it first).
        let allowance = parseFloat(holiday_allowance_hours);
        if (!Number.isFinite(allowance) || allowance < 0) allowance = 224;
        const params = [
            displayname || req.params.empfullname,
            email || '',
            groups || '',
            office || '',
            newBadge,
            allowance,
            admin ? 1 : 0,
            reports ? 1 : 0,
            time_admin ? 1 : 0,
            disabled ? 1 : 0,
        ];
        if (password && password.trim() !== '') {
            fields.push('employee_passwd = ?');
            params.push(hashPassword(password));
        }
        params.push(req.params.empfullname);
        await query(
            `UPDATE ${t('employees')} SET ${fields.join(', ')} WHERE empfullname = ?`,
            params
        );
        req.flash('success', `Updated ${req.params.empfullname}.`);
        res.redirect('/staff');
    } catch (err) { next(err); }
});

// DISABLE (soft-delete; matches PHP behaviour)
router.post('/:empfullname/disable', async (req, res, next) => {
    try {
        await query(
            `UPDATE ${t('employees')} SET disabled = 1 WHERE empfullname = ?`,
            [req.params.empfullname]
        );
        req.flash('success', `Disabled ${req.params.empfullname}.`);
        res.redirect('/staff');
    } catch (err) { next(err); }
});

// RE-ENABLE
router.post('/:empfullname/enable', async (req, res, next) => {
    try {
        await query(
            `UPDATE ${t('employees')} SET disabled = 0 WHERE empfullname = ?`,
            [req.params.empfullname]
        );
        req.flash('success', `Re-enabled ${req.params.empfullname}.`);
        res.redirect('/staff?show=all');
    } catch (err) { next(err); }
});

module.exports = router;
