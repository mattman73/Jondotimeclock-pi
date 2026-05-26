// Build a public-facing URL for a dashboard path, using the
// admin-configured "Dashboard public URL" setting.
//
// Falls back to http://localhost:PORT when nothing's configured —
// that's the safe default for an admin who hasn't yet filled it in
// (everything keeps working from the server itself), but the link
// will be useless in emails / WhatsApp until they set it.

function dashboardUrl(settings, path) {
    const raw = (settings && settings.dashboard_base_url)
        ? String(settings.dashboard_base_url).trim()
        : '';
    const base = raw.replace(/\/+$/, '')
        || `http://localhost:${process.env.PORT || 3000}`;
    const p = !path ? '' : (path[0] === '/' ? path : '/' + path);
    return base + p;
}

module.exports = { dashboardUrl };
