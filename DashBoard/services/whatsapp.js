// WhatsApp notifications via the Meta WhatsApp Business Cloud API.
//
// This runs ALONGSIDE email — it does not replace it. It is used to
// nudge managers about late staff and new time-off requests.
//
// Important constraints of the Cloud API:
//   - It cannot post into a WhatsApp *group*. It sends to individual
//     numbers, so whatsapp_recipients is a comma-separated list of
//     manager phone numbers in international format (digits only,
//     no +, no spaces — e.g. 447911123456).
//   - A business-initiated message must use a pre-approved template.
//     The admin creates ONE template in Meta Business Manager with a
//     single body variable {{1}}; we pass the whole alert text as
//     that variable. whatsapp_template is that template's name.
//
// Fail-soft: if WhatsApp is disabled or not fully configured, every
// call is a harmless no-op and email still goes out as before.

const { loadSettings } = require('./mailer');

const GRAPH_VERSION = 'v21.0';

// "447911123456, 44 7700 900111" -> ['447911123456','447700900111']
function parseRecipients(raw) {
    return String(raw || '')
        .split(/[,;\n]+/)
        .map(s => s.replace(/[^\d]/g, ''))
        .filter(s => s.length >= 8);
}

// Template body parameters can't contain newlines, tabs, or runs of
// 4+ spaces — collapse the text so the API doesn't reject it.
function cleanParam(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
}

async function sendOne(phoneId, token, to, template, lang, text) {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneId}/messages`;
    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
            name: template,
            language: { code: lang || 'en_GB' },
            components: [
                { type: 'body', parameters: [{ type: 'text', text }] },
            ],
        },
    };
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });
    if (!res.ok) {
        let detail = res.statusText;
        try {
            const j = await res.json();
            detail = (j && j.error && j.error.message) || JSON.stringify(j);
        } catch (e) { /* keep statusText */ }
        throw new Error(`HTTP ${res.status}: ${String(detail).slice(0, 300)}`);
    }
    return true;
}

// Send a WhatsApp notification to every configured manager number.
// Pass `settings` if you already have the alert_settings row, else
// it is loaded. Returns { sent, count, total, reason? }.
async function sendWhatsApp(text, settingsArg) {
    let settings = settingsArg;
    if (!settings) {
        try { settings = await loadSettings(); }
        catch (e) { return { sent: false, reason: 'could not load settings' }; }
    }
    if (!settings) return { sent: false, reason: 'no settings row' };
    if (!Number(settings.whatsapp_enabled)) {
        return { sent: false, reason: 'WhatsApp disabled' };
    }

    const phoneId = (settings.whatsapp_phone_id || '').trim();
    const token = (settings.whatsapp_token || '').trim();
    const template = (settings.whatsapp_template || '').trim();
    const lang = (settings.whatsapp_lang || 'en_GB').trim();
    const recipients = parseRecipients(settings.whatsapp_recipients);
    const body = cleanParam(text);

    if (!phoneId || !token || !template) {
        return { sent: false, reason: 'WhatsApp not fully configured' };
    }
    if (!recipients.length) {
        return { sent: false, reason: 'no WhatsApp recipients set' };
    }

    let count = 0;
    const errors = [];
    for (const to of recipients) {
        try {
            await sendOne(phoneId, token, to, template, lang, body);
            count += 1;
        } catch (e) {
            errors.push(`${to}: ${e.message}`);
        }
    }
    if (count === 0) {
        return {
            sent: false, count: 0, total: recipients.length,
            reason: errors.join(' | ') || 'all sends failed',
        };
    }
    return {
        sent: true, count, total: recipients.length,
        reason: errors.length ? ('partial — ' + errors.join(' | ')) : undefined,
    };
}

module.exports = { sendWhatsApp, parseRecipients };
