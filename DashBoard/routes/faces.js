// Face-recognition enrollment + consent management.
//
// Admin pages:
//   GET  /faces                     overview, per-employee status
//   GET  /faces/:emp                edit page (enroll, opt-in, view photos)
//   POST /faces/:emp/photo          upload a captured photo (multipart)
//   POST /faces/:emp/photo/:id/delete  soft-delete a photo
//   POST /faces/:emp/opt-in         set consent flag
//   POST /faces/:emp/opt-out        clear consent flag (keeps photos)
//   POST /faces/:emp/erase          GDPR right to erasure: delete all photos + audit
//   GET  /faces/:emp/photo/:id      stream a photo back (for the gallery)

const express = require('express');
const { query, t } = require('../db');
const { requireAdmin } = require('../services/auth');

const router = express.Router();
router.use(requireAdmin);

// We accept image uploads as raw bodies. Keep it under 5MB per photo.
const rawJpeg = express.raw({ type: ['image/jpeg', 'image/png'], limit: '5mb' });

// LIST
router.get('/', async (req, res, next) => {
    try {
        const rows = await query(
            `SELECT e.empfullname, e.displayname, e.face_opt_in, e.face_consent_at,
                    COUNT(f.id) AS photo_count,
                    MAX(f.captured_at) AS last_capture
             FROM ${t('employees')} e
             LEFT JOIN ${t('face_enrollments')} f
                    ON f.empfullname = e.empfullname AND f.deleted_at IS NULL
             WHERE e.disabled = 0
             GROUP BY e.empfullname, e.displayname, e.face_opt_in, e.face_consent_at
             ORDER BY e.displayname, e.empfullname`,
            []
        );
        res.render('faces/index', { title: 'Face recognition', rows });
    } catch (err) { next(err); }
});

// EDIT one employee
router.get('/:emp', async (req, res, next) => {
    try {
        const empRows = await query(
            `SELECT empfullname, displayname, email, face_opt_in, face_consent_at
             FROM ${t('employees')}
             WHERE empfullname = ?`,
            [req.params.emp]
        );
        if (!empRows.length) {
            req.flash('error', 'Employee not found.');
            return res.redirect('/faces');
        }
        const photos = await query(
            `SELECT id, captured_at, captured_by, image_mime
             FROM ${t('face_enrollments')}
             WHERE empfullname = ? AND deleted_at IS NULL
             ORDER BY captured_at DESC`,
            [req.params.emp]
        );
        const audit = await query(
            `SELECT confidence, action, reason, pi_host, captured_at
             FROM ${t('face_audit')}
             WHERE empfullname = ?
             ORDER BY captured_at DESC
             LIMIT 20`,
            [req.params.emp]
        );
        res.render('faces/edit', {
            title: empRows[0].displayname || empRows[0].empfullname,
            emp: empRows[0],
            photos,
            audit,
        });
    } catch (err) { next(err); }
});

// Stream a photo (so we can <img src=...> it on the gallery)
router.get('/:emp/photo/:id', async (req, res, next) => {
    try {
        const rows = await query(
            `SELECT image_blob, image_mime FROM ${t('face_enrollments')}
             WHERE id = ? AND empfullname = ? AND deleted_at IS NULL`,
            [req.params.id, req.params.emp]
        );
        if (!rows.length) return res.status(404).send('not found');
        res.setHeader('Content-Type', rows[0].image_mime || 'image/jpeg');
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.end(rows[0].image_blob);
    } catch (err) { next(err); }
});

// Upload a captured photo. Body is the raw jpeg/png bytes.
router.post('/:emp/photo', rawJpeg, async (req, res, next) => {
    try {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(400).json({ ok: false, error: 'no image' });
        }
        const mime = (req.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
        const by = (req.session.user && req.session.user.empfullname) || '';
        await query(
            `INSERT INTO ${t('face_enrollments')}
                (empfullname, image_blob, image_mime, captured_by)
             VALUES (?, ?, ?, ?)`,
            [req.params.emp, req.body, mime, by]
        );
        res.json({ ok: true });
    } catch (err) { next(err); }
});

// Soft-delete a single photo
router.post('/:emp/photo/:id/delete', async (req, res, next) => {
    try {
        await query(
            `UPDATE ${t('face_enrollments')} SET deleted_at = NOW()
             WHERE id = ? AND empfullname = ?`,
            [req.params.id, req.params.emp]
        );
        req.flash('success', 'Photo deleted.');
        res.redirect('/faces/' + encodeURIComponent(req.params.emp));
    } catch (err) { next(err); }
});

// Opt in (consent given)
router.post('/:emp/opt-in', async (req, res, next) => {
    try {
        await query(
            `UPDATE ${t('employees')}
             SET face_opt_in = 1, face_consent_at = NOW()
             WHERE empfullname = ?`,
            [req.params.emp]
        );
        req.flash('success', 'Consent recorded. The Pi scanner will start using this employee on next sync.');
        res.redirect('/faces/' + encodeURIComponent(req.params.emp));
    } catch (err) { next(err); }
});

// Opt out (does NOT delete photos — admin can re-enable)
router.post('/:emp/opt-out', async (req, res, next) => {
    try {
        await query(
            `UPDATE ${t('employees')}
             SET face_opt_in = 0, face_consent_at = NULL
             WHERE empfullname = ?`,
            [req.params.emp]
        );
        req.flash('success', 'Consent withdrawn. The Pi scanner will stop using this employee on next sync. Photos kept (use Erase to delete).');
        res.redirect('/faces/' + encodeURIComponent(req.params.emp));
    } catch (err) { next(err); }
});

// Right-to-erasure: delete photos and audit records.
router.post('/:emp/erase', async (req, res, next) => {
    try {
        await query(
            `UPDATE ${t('face_enrollments')} SET deleted_at = NOW()
             WHERE empfullname = ? AND deleted_at IS NULL`,
            [req.params.emp]
        );
        await query(
            `DELETE FROM ${t('face_audit')} WHERE empfullname = ?`,
            [req.params.emp]
        );
        await query(
            `UPDATE ${t('employees')}
             SET face_opt_in = 0, face_consent_at = NULL
             WHERE empfullname = ?`,
            [req.params.emp]
        );
        req.flash('success', 'All face data for this employee has been erased.');
        res.redirect('/faces/' + encodeURIComponent(req.params.emp));
    } catch (err) { next(err); }
});

module.exports = router;
