'use strict';
'require baseclass';

/* Five-field crond syntax only. Reject commands, macros and line breaks. */
function valid(expression) {
    if (typeof expression !== 'string' || /[\r\n\x00-\x08\x0b-\x1f\x7f]/.test(expression))
        return false;
    const fields = expression.trim().split(/[ \t]+/);
    if (fields.length !== 5) return false;
    const bounds = [[0,59], [0,23], [1,31], [1,12], [0,6]];
    const names = {
        3: ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'],
        4: ['SUN','MON','TUE','WED','THU','FRI','SAT']
    };
    return fields.every(function (field, index) {
        const value = function (token) {
            if (/^\d+$/.test(token)) return Number(token);
            const named = names[index]?.indexOf(token.toUpperCase()) ?? -1;
            return named < 0 ? NaN : named + bounds[index][0];
        };
        const inRange = function (number) {
            return Number.isSafeInteger(number) && number >= bounds[index][0] && number <= bounds[index][1];
        };
        return field.split(',').every(function (item) {
            const parts = item.split('/');
            if (parts.length > 2) return false;
            if (parts.length === 2 && (!/^\d+$/.test(parts[1]) ||
                !Number.isSafeInteger(Number(parts[1])) || Number(parts[1]) < 1 ||
                Number(parts[1]) > 2147483647)) return false;
            if (parts[0] === '*') return true;
            const range = parts[0].split('-');
            return range.length <= 2 && range.every(function (token) { return inRange(value(token)); });
        });
    });
}

return baseclass.extend({
    valid: valid,
    validate: function (sectionId, expression) {
        return valid(expression) || _('Enter five Cron fields: minute (0–59), hour (0–23), day (1–31), month (1–12), weekday (0–6, Sunday = 0). Lists, ranges and /steps are supported.');
    }
});
