'use strict';
'require baseclass';

function splitLines(text) {
    if (typeof text !== 'string')
        return [];
    return text.replace(/\r\n?/g, '\n').split('\n');
}

function computeOps(a, b) {
    const n = a.length;
    const m = b.length;
    const ops = [];
    const maxCells = 4000000;

    // Large inputs use a bounded prefix/suffix comparison instead of an
    // unbounded LCS table. Configuration files normally stay well below this.
    if (n * m > maxCells) {
        let prefix = 0;
        while (prefix < n && prefix < m && a[prefix] === b[prefix])
            prefix++;
        let suffix = 0;
        while (suffix < n - prefix && suffix < m - prefix &&
               a[n - 1 - suffix] === b[m - 1 - suffix])
            suffix++;
        for (let i = 0; i < prefix; i++)
            ops.push({ type: ' ', text: a[i] });
        for (let i = prefix; i < n - suffix; i++)
            ops.push({ type: '-', text: a[i] });
        for (let i = prefix; i < m - suffix; i++)
            ops.push({ type: '+', text: b[i] });
        for (let i = n - suffix; i < n; i++)
            ops.push({ type: ' ', text: a[i] });
        return ops;
    }

    const width = m + 1;
    const dp = new Int32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
        const row = i * width;
        const next = row + width;
        for (let j = m - 1; j >= 0; j--) {
            if (a[i] === b[j])
                dp[row + j] = dp[next + j + 1] + 1;
            else
                dp[row + j] = Math.max(dp[next + j], dp[row + j + 1]);
        }
    }

    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            ops.push({ type: ' ', text: a[i] });
            i++;
            j++;
        }
        else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
            ops.push({ type: '-', text: a[i] });
            i++;
        }
        else {
            ops.push({ type: '+', text: b[j] });
            j++;
        }
    }
    while (i < n)
        ops.push({ type: '-', text: a[i++] });
    while (j < m)
        ops.push({ type: '+', text: b[j++] });
    return ops;
}

function annotate(ops) {
    let oldLine = 1;
    let newLine = 1;
    for (const op of ops) {
        if (op.type !== '+')
            op.old = oldLine++;
        if (op.type !== '-')
            op.new = newLine++;
    }
}

function unified(before, after, context) {
    context = (context == null) ? 3 : context;
    const ops = computeOps(splitLines(before), splitLines(after));
    annotate(ops);

    const changed = [];
    for (let i = 0; i < ops.length; i++) {
        if (ops[i].type !== ' ')
            changed.push(i);
    }
    if (changed.length === 0)
        return [];

    const hunks = [];
    let start = Math.max(0, changed[0] - context);
    let end = Math.min(ops.length - 1, changed[0] + context);
    for (let k = 1; k < changed.length; k++) {
        const index = changed[k];
        if (index - context <= end + 1) {
            end = Math.min(ops.length - 1, index + context);
        }
        else {
            hunks.push([start, end]);
            start = Math.max(0, index - context);
            end = Math.min(ops.length - 1, index + context);
        }
    }
    hunks.push([start, end]);

    const lines = [];
    for (const hunk of hunks) {
        const from = hunk[0];
        const to = hunk[1];
        let oldStart = null;
        let newStart = null;
        let oldCount = 0;
        let newCount = 0;
        for (let i = from; i <= to; i++) {
            const op = ops[i];
            if (op.type !== '+') {
                if (oldStart === null)
                    oldStart = op.old;
                oldCount++;
            }
            if (op.type !== '-') {
                if (newStart === null)
                    newStart = op.new;
                newCount++;
            }
        }
        lines.push({
            type: '@',
            text: '@@ -' + (oldStart === null ? 0 : oldStart) + ',' + oldCount +
                  ' +' + (newStart === null ? 0 : newStart) + ',' + newCount + ' @@'
        });
        for (let i = from; i <= to; i++)
            lines.push(ops[i]);
    }
    return lines;
}

function stats(lines) {
    let added = 0;
    let removed = 0;
    for (const line of lines) {
        if (line.type === '+')
            added++;
        else if (line.type === '-')
            removed++;
    }
    return { added: added, removed: removed };
}

return baseclass.extend({
    unified: unified,
    stats: stats
});
