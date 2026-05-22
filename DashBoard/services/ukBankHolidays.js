// UK bank holiday helpers — computed in JS so we don't have to
// pull a network feed every time. Coverage: England & Wales.
// Easter dates use the standard Anonymous Gregorian algorithm.
//
// For Scotland / Northern Ireland the dates differ slightly
// (e.g. 2nd Jan in Scotland, July 12th in NI). Admins can add
// any extras via /holidays.

function easterSunday(year) {
    // Anonymous Gregorian algorithm.
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
}

function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

// Push date forward to the next Monday if it falls on weekend.
function substituteIfWeekend(date) {
    const dow = date.getDay(); // 0 Sun, 6 Sat
    if (dow === 0) return addDays(date, 1);
    if (dow === 6) return addDays(date, 2);
    return date;
}

// Last Monday of a given month (May / August).
function lastMondayOf(year, monthIndex) {
    const d = new Date(year, monthIndex + 1, 0); // last day of month
    while (d.getDay() !== 1) d.setDate(d.getDate() - 1);
    return d;
}

// First Monday of a given month (May).
function firstMondayOf(year, monthIndex) {
    const d = new Date(year, monthIndex, 1);
    while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
    return d;
}

function ymd(d) {
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// Returns [{date: "YYYY-MM-DD", label}] for the given year, England & Wales.
function ukBankHolidays(year) {
    const easter = easterSunday(year);
    return [
        { date: ymd(substituteIfWeekend(new Date(year, 0, 1))),  label: "New Year's Day" },
        { date: ymd(addDays(easter, -2)),                        label: "Good Friday" },
        { date: ymd(addDays(easter, 1)),                         label: "Easter Monday" },
        { date: ymd(firstMondayOf(year, 4)),                     label: "Early May bank holiday" },
        { date: ymd(lastMondayOf(year, 4)),                      label: "Spring bank holiday" },
        { date: ymd(lastMondayOf(year, 7)),                      label: "Summer bank holiday" },
        { date: ymd(substituteIfWeekend(new Date(year, 11, 25))), label: "Christmas Day" },
        { date: ymd(substituteIfWeekend(addDays(new Date(year, 11, 25), 1))), label: "Boxing Day" },
    ];
}

module.exports = { ukBankHolidays, ymd };
