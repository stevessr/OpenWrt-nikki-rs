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

/* Split one Clash routing rule into its typed parts. Rules are matched top
 * to bottom; the canonical form is TYPE,VALUE,POLICY with optional trailing
 * flags such as no-resolve or src. MATCH omits the value part and SUB-RULE
 * keeps everything after the type as an opaque payload. */
function parseRule(text) {
    const raw = String(text == null ? '' : text);
    const result = { type: '', value: '', policy: '', options: '', raw: raw };
    const parts = raw.split(',');
    if (parts.length < 2) {
        result.value = raw.trim();
        return result;
    }
    result.type = parts[0].trim();
    if (parts.length === 2) {
        result.policy = parts[1].trim();
        return result;
    }
    if (/^SUB-RULE$/i.test(result.type)) {
        result.value = parts.slice(1, -1).join(',').trim();
        result.policy = parts[parts.length - 1].trim();
        return result;
    }
    const options = [];
    let end = parts.length - 2;
    // With only three parts, the final token is the policy even if its name
    // happens to match an option. An option suffix requires a separate policy.
    while (end >= 2 && /^(no-resolve|no-resolve-src|src)$/i.test(parts[end + 1].trim())) {
        options.unshift(parts[end + 1].trim().toLowerCase());
        end--;
    }
    result.policy = parts[end + 1].trim();
    result.options = options.join(', ');
    result.value = parts.slice(1, end + 1).join(',').trim();
    return result;
}

/* Semantic rule-level diff. Sequence alignment reports only relative-order
 * changes as moves; insertion and deletion do not mark every following rule
 * as moved simply because its numeric priority shifted. */
function ruleDiff(a, b) {
    a = Array.isArray(a) ? a : [];
    b = Array.isArray(b) ? b : [];
    const ops = computeOps(a, b);
    annotate(ops);

    const removed = [];
    const added = [];
    for (const op of ops) {
        if (op.type === '-') removed.push(op);
        else if (op.type === '+') added.push(op);
    }

    const removedByText = Object.create(null);
    const addedByText = Object.create(null);
    for (const op of removed) (removedByText[op.text] = removedByText[op.text] || []).push(op);
    for (const op of added) (addedByText[op.text] = addedByText[op.text] || []).push(op);
    const movedOld = {};
    const movedNew = {};
    for (const text in removedByText) {
        const from = removedByText[text];
        const to = addedByText[text] || [];
        while (from.length && to.length) {
            const oldOp = from.shift();
            const newOp = to.shift();
            movedOld[oldOp.old] = { old: oldOp.old, new: newOp.new, text: text };
            movedNew[newOp.new] = true;
        }
    }

    // An LCS may preserve a moved element and instead remove another element
    // from the same reordered block. Pair those leftovers as relative moves.
    const freeRemoved = removed.filter(function (op) { return !movedOld[op.old]; });
    const freeAdded = added.filter(function (op) { return !movedNew[op.new]; });
    const movedCount = Math.min(freeRemoved.length, freeAdded.length);
    for (let i = 0; i < movedCount; i++) {
        const oldOp = freeRemoved[i];
        const newOp = freeAdded[i];
        if (oldOp.text === newOp.text) {
            movedOld[oldOp.old] = { old: oldOp.old, new: newOp.new, text: oldOp.text };
            movedNew[newOp.new] = true;
        }
    }

    const entries = [];
    for (const op of ops) {
        if (op.type === ' ') {
            entries.push({ status: 'unchanged', old: op.old, new: op.new, text: op.text });
        }
        else if (op.type === '-') {
            if (movedOld[op.old]) {
                const move = movedOld[op.old];
                entries.push({ status: 'moved', old: move.old, new: move.new, text: move.text });
            }
            else {
                entries.push({ status: 'removed', old: op.old, new: null, text: op.text });
            }
        }
        else if (!movedNew[op.new]) {
            entries.push({ status: 'added', old: null, new: op.new, text: op.text });
        }
    }
    return entries;
}

function ruleStats(entries) {
    const counts = { added: 0, removed: 0, moved: 0, unchanged: 0 };
    for (const entry of entries) {
        if (counts[entry.status] != null)
            counts[entry.status]++;
    }
    return counts;
}

function duplicateRules(rules) {
    const seen = Object.create(null);
    let duplicates = 0;
    for (const rule of (Array.isArray(rules) ? rules : [])) {
        if (seen[rule])
            duplicates++;
        seen[rule] = true;
    }
    return duplicates;
}

function providerDiff(before, after) {
    const beforeSet = Object.create(null);
    for (const name of (Array.isArray(before) ? before : []))
        beforeSet[name] = true;
    const afterSet = Object.create(null);
    for (const name of (Array.isArray(after) ? after : []))
        afterSet[name] = true;
    const added = [];
    const removed = [];
    for (const name in afterSet)
        if (!beforeSet[name])
            added.push(name);
    for (const name in beforeSet)
        if (!afterSet[name])
            removed.push(name);
    added.sort();
    removed.sort();
    return { added: added, removed: removed };
}

function toUciRule(value) {
    if (typeof value === 'string') {
        const parsed = parseRule(value);
        if (!parsed.type || !parsed.policy)
            return null;
        return {
            type: parsed.type.trim(),
            matcher: /^MATCH$/i.test(parsed.type) ? '' : parsed.value.trim(),
            node: parsed.policy.trim(),
            no_resolve: /(?:^|,\s*)no-resolve(?:,|$)/i.test(parsed.options)
        };
    }
    if (!value || typeof value !== 'object')
        return null;
    const rule = {
        type: String(value.type || '').trim(),
        matcher: String(value.matcher || '').trim(),
        node: String(value.node || value.policy || '').trim(),
        no_resolve: value.no_resolve === true || value.no_resolve === 1 || value.no_resolve === '1'
    };
    return rule.type && rule.node ? rule : null;
}

function uciRuleKey(value) {
    const rule = toUciRule(value);
    if (!rule)
        return null;
    return [rule.type.toUpperCase(), rule.matcher, rule.node, rule.no_resolve ? 'no-resolve' : ''].join(',');
}

function mergeImportedRules(source, existing) {
    const seen = Object.create(null);
    for (const value of (Array.isArray(existing) ? existing : [])) {
        const key = uciRuleKey(value);
        if (key != null)
            seen[key] = true;
    }

    const added = [];
    let duplicates = 0;
    let invalid = 0;
    for (const value of (Array.isArray(source) ? source : [])) {
        const rule = toUciRule(value);
        if (!rule) {
            invalid++;
            continue;
        }
        const key = uciRuleKey(rule);
        if (seen[key]) {
            duplicates++;
            continue;
        }
        seen[key] = true;
        added.push(rule);
    }
    return { rules: added, duplicates: duplicates, invalid: invalid };
}

const statusLabels = {
    added: [ '+', '#1a7f37', '#e6ffec' ],
    removed: [ '−', '#cf222e', '#ffebe9' ],
    moved: [ '⇅', '#9a6700', '#fff8c5' ],
    unchanged: [ '=', '#57606a', '' ]
};

function statusCell(entry, labels) {
    const label = labels[entry.status] || labels.unchanged;
    const style = 'display:inline-block;min-width:1.4em;text-align:center;' +
        'border-radius:3px;font-weight:bold;padding:0 .3em;color:' + label[1] +
        ';background:' + (label[2] || 'transparent');
    return E('span', { style: style, 'title': entry.status }, label[0]);
}

function priorityCell(entry) {
    const old = entry.old == null ? '–' : entry.old;
    const current = entry.new == null ? '–' : entry.new;
    return E('span', { 'style': 'white-space:nowrap' },
        entry.status === 'unchanged' ? String(current) :
        (String(old) + ' → ' + String(current)));
}

function ruleRows(entries, duplicates, limit) {
    const rows = [];
    const afterSeen = Object.create(null);
    let rendered = 0;
    for (const entry of entries) {
        if (rendered >= limit)
            break;
        if (duplicates && entry.new != null) {
            const duplicate = afterSeen[entry.text] == true;
            afterSeen[entry.text] = true;
            if (duplicate)
                entry.duplicate = true;
        }
        rendered++;
        const parsed = parseRule(entry.text);
        const label = statusLabels[entry.status] || statusLabels.unchanged;
        const row = E('tr', {
            'class': 'nikki-rule-row nikki-rule-row-' + entry.status +
                (entry.duplicate ? ' nikki-rule-duplicate' : ''),
            'style': (entry.status === 'unchanged' ? 'display:none' : '') +
                (label[2] ? ';background:' + label[2] + '40' : '') +
                (entry.duplicate ? ';text-decoration:underline dotted' : '')
        }, [
            E('td', { 'style': 'text-align:center' }, statusCell(entry, statusLabels)),
            E('td', {}, priorityCell(entry)),
            E('td', {}, [
                E('span', { 'style': 'font-family:monospace;white-space:nowrap' }, parsed.type || '–')
            ]),
            E('td', { 'title': entry.text }, [
                E('span', { 'style': 'display:inline-block;max-width:34vw;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom;white-space:nowrap' }, parsed.value || '–')
            ]),
            E('td', {}, [
                E('span', { 'style': 'font-family:monospace;white-space:nowrap' }, parsed.policy || '–'),
                parsed.options ? E('span', { 'style': 'color:#57606a;font-size:.9em' }, ' · ' + parsed.options) : ''
            ]),
            E('td', {}, entry.duplicate ? _('Duplicate rule') : '')
        ]);
        rows.push(row);
    }
    return rows;
}

function summaryBadge(label, count, color, background) {
    return E('span', {
        'style': 'display:inline-block;margin:0 .35em .35em 0;padding:.15em .6em;' +
            'border-radius:1em;font-weight:bold;color:' + color +
            ';background:' + background + ';border:1px solid ' + color + '40'
    }, label + ' ' + count);
}

/* Shared visualization of routing-rule changes between two effective
 * configurations. Consumes the rules_before/rules_after views returned by
 * the editor_diff rpc; renders a summary, rule-provider changes and a
 * structured rule table instead of a raw YAML wall of text. */
function rulesReport(beforeView, afterView) {
    if (!beforeView || !afterView ||
        !Array.isArray(beforeView.rules) || !Array.isArray(afterView.rules))
        return E('p', {}, _('No rule-level comparison is available for this file.'));

    const entries = ruleDiff(beforeView.rules, afterView.rules);
    const counts = ruleStats(entries);
    const duplicates = duplicateRules(afterView.rules);
    const changed = counts.added + counts.removed + counts.moved;
    const partial = beforeView.truncated || afterView.truncated;
    const partialSuffix = partial ? ' (' + _('partial') + ')' : '';

    const badges = [
        summaryBadge('+ ' + _('Added') + partialSuffix, counts.added, '#1a7f37', '#e6ffec'),
        summaryBadge('− ' + _('Removed') + partialSuffix, counts.removed, '#cf222e', '#ffebe9'),
        summaryBadge('⇅ ' + _('Moved') + partialSuffix, counts.moved, '#9a6700', '#fff8c5'),
        summaryBadge('= ' + _('Unchanged') + partialSuffix, counts.unchanged, '#57606a', '#f6f8fa')
    ];
    if (duplicates > 0)
        badges.push(summaryBadge(_('Duplicates'), duplicates, '#8250df', '#fbefff'));

    const providers = providerDiff(beforeView.rule_providers, afterView.rule_providers);
    const providerSummary = [];
    if (providers.added.length)
        providerSummary.push(E('span', { 'style': 'color:#1a7f37' },
            _('Added rule providers') + ': ' + providers.added.join(', ')));
    if (providers.removed.length)
        providerSummary.push(E('span', { 'style': 'color:#cf222e' },
            _('Removed rule providers') + ': ' + providers.removed.join(', ')));
    if (providerSummary.length === 0)
        providerSummary.push(E('span', {}, partial ?
            _('No provider changes found in the extracted portion.') : _('Rule providers unchanged')));

    const limit = 3000;
    const rows = ruleRows(entries, duplicates, limit);
    const table = E('table', { 'class': 'table', 'style': 'width:100%;table-layout:fixed' }, [
        E('thead', {}, E('tr', {}, [
            E('th', { 'style': 'width:3em' }, _('Change')),
            E('th', { 'style': 'width:6em' }, _('Priority')),
            E('th', { 'style': 'width:9em' }, _('Rule type')),
            E('th', {}, _('Match value')),
            E('th', { 'style': 'width:16%' }, _('Target policy')),
            E('th', { 'style': 'width:6em' }, _('Notes'))
        ])),
        E('tbody', {}, rows)
    ]);
    table.classList.add('nikki-rules-table');

    const showAll = E('label', { 'style': 'display:block;margin:.4em 0' }, [
        E('input', { 'type': 'checkbox', 'change': function () {
            const visible = this.checked;
            table.querySelectorAll('.nikki-rule-row-unchanged').forEach(function (row) {
                row.style.display = visible ? '' : 'none';
            });
        } }),
        ' ' + _('Show unchanged rules')
    ]);

    const truncated = (beforeView.truncated || afterView.truncated) ?
        E('p', { 'class': 'cbi-value-description', 'style': 'color:#9a6700' },
            _('Rule details were truncated during extraction. Change counts, duplicate counts, and provider differences cover only the extracted portion.')) : '';

    return E('div', { 'class': 'nikki-rules-report' }, [
        E('div', { 'style': 'margin:.3em 0 .5em' }, badges),
        E('p', { 'style': 'margin:.2em 0' }, providerSummary),
        E('p', { 'class': 'cbi-value-description' },
            _('Rules are matched from top to bottom. The priority column shows the old and new position of every changed rule.')),
        changed === 0 && !partial ? E('p', { 'style': 'font-weight:bold' },
            _('No routing rule changes.')) : '',
        showAll,
        table,
        entries.length > limit ? E('p', { 'class': 'cbi-value-description' },
            _('Display limited to the first 3000 rules.')) : '',
        truncated
    ]);
}

return baseclass.extend({
    unified: unified,
    stats: stats,
    parseRule: parseRule,
    ruleDiff: ruleDiff,
    ruleStats: ruleStats,
    duplicateRules: duplicateRules,
    providerDiff: providerDiff,
    toUciRule: toUciRule,
    mergeImportedRules: mergeImportedRules,
    rulesReport: rulesReport
});
