'use strict';
'require view';
'require ui';
'require tools.nikki-rs as nikki';

const types = [
    'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'GEOIP', 'GEOSITE',
    'IP-CIDR', 'IP-CIDR6', 'SRC-IP-CIDR', 'RULE-SET',
    'DST-PORT', 'SRC-PORT', 'PROCESS-NAME', 'PROCESS-PATH', 'NETWORK', 'MATCH'
];

function notify(message, ok) {
    ui.addNotification(null, E('p', {}, message), ok ? 'info' : 'danger');
}

return view.extend({
    load: function () {
        return nikki.rulesList();
    },
    render: function (initial) {
        let rules = Array.isArray(initial.rules) ? initial.rules.slice() : [];
        let revision = initial.revision || '';
        let dirty = false;
        let inFlight = false;

        const main = E('div', { 'class': 'cbi-map' });
        const status = E('p', { 'class': 'cbi-value-description' });
        const warnings = E('div');
        const rows = E('div');
        const actions = E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:.6em;margin:1em 0' });
        const templateType = E('select', { 'class': 'cbi-input-select' },
            types.map(function (type) { return E('option', { 'value': type }, type); }));
        const templateMatch = E('input', { 'type': 'text', 'class': 'cbi-input-text',
            'placeholder': _('Domain, CIDR, rule set or port'), 'style': 'min-width:240px' });
        const templateTarget = E('input', { 'type': 'text', 'class': 'cbi-input-text',
            'placeholder': _('Policy target, e.g. DIRECT'), 'value': 'DIRECT' });
        const templateNoResolve = E('input', { 'type': 'checkbox' });
        const importBox = E('textarea', { 'class': 'cbi-input-textarea', 'rows': 4,
            'style': 'width:100%', 'placeholder': _('Paste one Clash rule per line to append them') });

        function button(label, action) {
            return E('button', { 'class': 'btn cbi-button', 'type': 'button',
                'click': function () {
                    if (inFlight) return;
                    try { return Promise.resolve(action()).catch(function (err) {
                        notify(String(err), false);
                    }); } catch (err) { notify(String(err), false); }
                } }, label);
        }

        function validate(line) {
            if (typeof line !== 'string' || line.length < 3 || line.length > 1024 ||
                /[\r\n\x00-\x1f\x7f]/.test(line)) return false;
            const tokens = line.split(',');
            if (tokens.length < 2 || tokens.length > 4 ||
                tokens.some(function (value) { return !value.trim(); })) return false;
            if (tokens[0] === 'MATCH') return tokens.length === 2;
            if (tokens.length === 4 && tokens[3] !== 'no-resolve') return false;
            return !(tokens.length === 3 && tokens[2] === 'no-resolve');
        }

        function redraw() {
            status.textContent = _('Rules in this module: ') + rules.length +
                (dirty ? ' — ' + _('Unsaved changes') : ' — ' + _('Saved'));
            warnings.replaceChildren();
            const seen = new Set();
            let repeats = 0, shadowed = 0;
            rules.forEach(function (line, index) {
                if (seen.has(line)) repeats++;
                seen.add(line);
                if (index < rules.length - 1 && line.startsWith('MATCH,')) shadowed++;
            });
            if (repeats) warnings.appendChild(E('p', { 'style': 'color:#b45f06' },
                _('Duplicate lines: ') + repeats));
            if (shadowed) warnings.appendChild(E('p', { 'style': 'color:#b45f06' },
                _('MATCH is not last. Later entries in this module may never match.')));
            rows.replaceChildren();
            rules.forEach(function (line, index) {
                const value = E('input', { 'type': 'text', 'class': 'cbi-input-text',
                    'style': 'width:100%', 'value': line, 'maxlength': 1024,
                    'input': function (event) {
                        rules[index] = event.target.value;
                        dirty = true;
                        status.textContent = _('Unsaved changes');
                    } });
                const row = E('div', {
                    'style': 'display:flex;gap:.4em;align-items:center;flex-wrap:wrap;margin:.35em 0'
                }, [
                    E('span', { 'style': 'width:2em;text-align:right' }, String(index + 1) + '.'),
                    E('div', { 'style': 'flex:1;min-width:240px' }, value),
                    button('↑', function () { if (index === 0) return; const tmp = rules[index-1];
                        rules[index-1] = rules[index]; rules[index] = tmp; dirty = true; redraw(); }),
                    button('↓', function () { if (index === rules.length-1) return; const tmp = rules[index+1];
                        rules[index+1] = rules[index]; rules[index] = tmp; dirty = true; redraw(); }),
                    button(_('Duplicate'), function () { rules.splice(index+1, 0, rules[index]);
                        dirty = true; redraw(); }),
                    button(_('Delete'), function () { rules.splice(index, 1); dirty = true; redraw(); })
                ]);
                rows.appendChild(row);
            });
        }

        function fetchRules() {
            inFlight = true;
            return nikki.rulesList().then(function (result) {
                if (!result.success || !Array.isArray(result.rules) || !result.revision)
                    throw new Error(result.error || _('Could not read current rule list'));
                rules = result.rules.slice();
                revision = result.revision;
                dirty = false;
                redraw();
            }).finally(function () { inFlight = false; });
        }

        if (!initial.success) {
            main.appendChild(E('p', {}, initial.error || _('Could not load rule file')));
        }
        actions.appendChild(button(_('Save ordered rules'), function () {
            if (!revision) return notify(_('Reload the rule file first'), false);
            if (!dirty) return notify(_('Nothing to save'), true);
            if (!rules.every(validate)) return notify(
                _('Some rules are invalid; use TYPE,MATCHER,TARGET[,no-resolve] or MATCH,TARGET'), false);
            inFlight = true;
            return nikki.rulesSave(rules, revision).then(function (result) {
                if (!result.success) throw new Error(result.error || _('Rule save failed'));
                return fetchRules().then(function () {
                    notify(_('Ordered rules saved with a revision backup. Restart Nikki RS to apply them.'), true);
                });
            }).finally(function () { inFlight = false; });
        }));
        actions.appendChild(button(_('Reload from disk'), function () {
            if (dirty && !window.confirm(_('Discard unsaved rule edits?'))) return;
            return fetchRules();
        }));

        const quick = E('div', { 'class': 'cbi-section' }, [
            E('h3', {}, _('Add a structured rule')),
            E('p', {}, _('Rules are evaluated from top to bottom. Append custom rules above the subscription rules.')),
            E('div', { 'style': 'display:flex;align-items:center;gap:.5em;flex-wrap:wrap' },
                [templateType, templateMatch, templateTarget,
                    E('label', {}, [templateNoResolve, _('no-resolve')]),
                    button(_('Add'), function () {
                        const type = templateType.value;
                        const target = templateTarget.value.trim();
                        const matcher = templateMatch.value.trim();
                        const line = type === 'MATCH' ? 'MATCH,' + target :
                            type + ',' + matcher + ',' + target +
                            (templateNoResolve.checked ? ',no-resolve' : '');
                        if (!validate(line)) return notify(_('Invalid rule fields'), false);
                        rules.push(line); dirty = true; redraw();
                    })]),
            E('h3', {}, _('Bulk append rules')),
            importBox,
            button(_('Append lines'), function () {
                const lines = importBox.value.split(/\r?\n/).map(function (line) { return line.trim(); })
                    .filter(Boolean);
                if (!lines.length) return;
                if (!lines.every(validate)) return notify(_('Bulk input has invalid rules'), false);
                rules.push.apply(rules, lines); dirty = true; importBox.value = ''; redraw();
            })
        ]);

        main.appendChild(E('h2', {}, _('Ordered Clash Rules')));
        main.appendChild(E('p', {}, _('This editor manages only nikki-rules in rules.yaml and preserves other advanced YAML settings. Concurrent edits in another browser tab are rejected.')));
        main.appendChild(status);
        main.appendChild(warnings);
        main.appendChild(actions);
        main.appendChild(rows);
        main.appendChild(quick);
        main.appendChild(E('p', { 'class': 'cbi-value-description' }, [
            _('For arbitrary YAML fields and merged previews, use '),
            E('a', { 'href': L.url('admin/services/nikki-rs/overrides') }, _('Advanced Config'))
        ]));
        redraw();
        return main;
    },
    handleSave: null,
    handleSaveApply: null,
    handleReset: null
});
