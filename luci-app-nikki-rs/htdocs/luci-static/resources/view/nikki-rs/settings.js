'use strict';
'require view';
'require ui';
'require tools.nikki-rs as nikki';

const modules = [
    ['general', _('General / Inbound / Cache')],
    ['dns', _('DNS / DNS2')],
    ['tun', _('TUN')],
    ['sniffer', _('Sniffer')],
    ['custom', _('Controller UI / Geo')]
];

function notify(message, success) {
    ui.addNotification(null, E('p', {}, message), success ? 'info' : 'danger');
}

function editorControl(field, current, onChange) {
    let control;
    const value = current == null ? null : current;
    if (field.kind === 'bool') {
        control = E('select', { 'class': 'cbi-input-select' }, [
            E('option', { 'value': 'true' }, _('Enabled')),
            E('option', { 'value': 'false' }, _('Disabled'))
        ]);
        control.value = value === false ? 'false' : 'true';
    } else if (field.kind === 'enum') {
        control = E('select', { 'class': 'cbi-input-select' },
            (field.choices || []).map(function (option) {
                return E('option', { 'value': option }, option);
            }));
        if (value != null) control.value = String(value);
    } else if (field.kind === 'list') {
        control = E('textarea', { 'class': 'cbi-input-textarea', 'rows': 3,
            'style': 'width:100%;min-width:230px;resize:vertical',
            'placeholder': _('One value per line') },
        Array.isArray(value) ? value.join('\n') : '');
    } else {
        const props = {
            'class': 'cbi-input-text',
            'type': (field.kind === 'port' || field.kind === 'int') ? 'number' : 'text',
            'style': 'width:100%;min-width:230px',
            'value': value == null ? '' : String(value)
        };
        if (field.kind === 'port') { props.min = 0; props.max = 65535; }
        if (field.kind === 'int') {
            if (field.min != null) props.min = field.min;
            if (field.max != null) props.max = field.max;
        }
        control = E('input', props);
    }
    control.addEventListener('change', onChange);
    control.addEventListener('input', onChange);
    return control;
}

function parsedValue(field, control) {
    if (field.kind === 'bool') return control.value === 'true';
    if (field.kind === 'int' || field.kind === 'port') {
        const text = control.value.trim();
        if (!/^[0-9]+$/.test(text)) throw new Error(_('Expected a non-negative integer: ') + field.label);
        const number = Number(text);
        const min = field.kind === 'port' ? 0 : (field.min ?? 0);
        const max = field.kind === 'port' ? 65535 : (field.max ?? 4294967295);
        if (!Number.isSafeInteger(number) || number < min || number > max)
            throw new Error(_('Value is out of range: ') + field.label);
        return number;
    }
    if (field.kind === 'list') {
        const lines = control.value.split(/\r?\n/).map(function (line) { return line.trim(); })
            .filter(Boolean);
        if (lines.length > 128 || lines.some(function (line) { return line.length > 512; }))
            throw new Error(_('List is too large: ') + field.label);
        return lines;
    }
    return control.value.trim();
}

return view.extend({
    load: function () { return nikki.settingsRead('general'); },
    render: function (initial) {
        let module = 'general';
        let revision = '';
        let pending = {};
        let busy = false;
        const selection = E('select', { 'class': 'cbi-input-select', 'style': 'min-width:240px' },
            modules.map(function (item) {
                return E('option', { 'value': item[0] }, item[1]);
            }));
        const area = E('div', { 'class': 'cbi-section' });
        const status = E('p', { 'class': 'cbi-value-description' });
        const actions = E('div', { 'style': 'display:flex;gap:.6em;flex-wrap:wrap;margin:1em 0' });
        const dirty = function () { return Object.keys(pending).length > 0; };
        const setBusy = function (value) {
            busy = value;
            selection.disabled = value;
            Array.from(actions.querySelectorAll('button')).forEach(function (button) {
                button.disabled = value;
            });
        };
        const execute = function (task) {
            if (busy) return;
            setBusy(true);
            return Promise.resolve().then(task).catch(function (error) {
                notify(String(error), false);
            }).finally(function () { setBusy(false); });
        };
        function mark() {
            status.textContent = dirty() ?
                _('Unsaved changes in this module. Review and save before switching.') :
                _('No pending changes. Fields set to Inherit do not replace existing subscription or mixin values.');
        }
        function build(response) {
            if (!response || !response.success ||
                !Array.isArray(response.fields) || !response.revision) {
                area.replaceChildren(E('p', {}, response?.error || _('Could not load this module')));
                revision = '';
                return;
            }
            revision = response.revision;
            pending = {};
            area.replaceChildren();
            response.fields.forEach(function (field) {
                const value = response.values?.[field.id];
                const explicit = value !== null && value !== undefined;
                const override = E('input', { 'type': 'checkbox', 'checked': explicit });
                override.checked = explicit;
                let input;
                const handler = function () {
                    if (!override.checked) {
                        pending[field.id] = null;
                    } else {
                        try {
                            pending[field.id] = parsedValue(field, input);
                        } catch (error) {
                            // Keep the draft visible so a later save can surface the error.
                            pending[field.id] = undefined;
                        }
                    }
                    mark();
                };
                input = editorControl(field, value, handler);
                input.disabled = !explicit;
                override.addEventListener('change', function () {
                    input.disabled = !override.checked;
                    handler();
                });
                const row = E('div', {
                    'style': 'display:grid;grid-template-columns:minmax(150px,1fr) minmax(240px,2fr);gap:.7em;align-items:start;padding:.65em 0;border-bottom:1px solid var(--border-color-low,#ddd)'
                }, [
                    E('label', { 'style': 'font-weight:600' }, field.label),
                    E('div', { 'style': 'display:flex;gap:.8em;align-items:center;flex-wrap:wrap' }, [
                        E('label', { 'style': 'white-space:nowrap' }, [override, ' ', _('Override')]),
                        E('div', { 'style': 'flex:1;min-width:230px' }, input),
                        E('code', { 'style': 'font-size:.85em' }, field.path)
                    ])
                ]);
                area.appendChild(row);
            });
            mark();
        }
        function snapshot() {
            const updates = {};
            for (const key of Object.keys(pending)) {
                if (pending[key] === undefined)
                    throw new Error(_('A field has an invalid value: ') + key);
                updates[key] = pending[key];
            }
            return updates;
        }
        function reload() {
            return nikki.settingsRead(module).then(function (result) {
                if (!result.success) throw new Error(result.error || _('Cannot refresh settings'));
                build(result);
            });
        }
        const btn = function (label, className, callback) {
            return E('button', { 'type': 'button', 'class': 'btn cbi-button cbi-button-' + className,
                'click': function () { return execute(callback); } }, label);
        };
        selection.addEventListener('change', function () {
            const next = selection.value;
            if (dirty() && !window.confirm(_('Discard unsaved edits in the current module?'))) {
                selection.value = module;
                return;
            }
            execute(function () {
                return nikki.settingsRead(next).then(function (result) {
                    if (!result.success) {
                        selection.value = module;
                        throw new Error(result.error || _('Could not load module'));
                    }
                    module = next;
                    build(result);
                });
            });
        });
        actions.appendChild(btn(_('Reload'), 'action', function () {
            if (dirty() && !window.confirm(_('Discard current draft?'))) return;
            return reload();
        }));
        actions.appendChild(btn(_('Save overrides'), 'positive', function () {
            const delta = snapshot();
            if (!Object.keys(delta).length) return notify(_('No modified fields.'), true);
            return nikki.settingsPatch(module, delta, revision).then(function (result) {
                if (!result.success) throw new Error(result.error || _('Save failed'));
                return reload().then(function () {
                    notify(_('Settings saved with a revision backup. Apply through Advanced Config or use Test and apply.'), true);
                });
            });
        }));
        actions.appendChild(btn(_('Review merged configuration'), 'action', function () {
            const delta = snapshot();
            if (!Object.keys(delta).length) return notify(_('No modified fields.'), true);
            return nikki.settingsDraft(module, delta, revision).then(function (draft) {
                if (!draft.success) throw new Error(draft.error || _('Could not generate draft'));
                return nikki.overridePreview(module, draft.content).then(function (result) {
                    if (!result.success) throw new Error(result.error || _('Cannot merge draft'));
                    ui.showModal(_('Effective configuration preview'), [
                        E('p', {}, _('The effective YAML may contain proxy addresses, tokens and other secrets. This preview does not modify the running service. eBPF mode overrides TUN.')),
                        E('textarea', { 'readonly': '', 'rows': 24,
                            'style': 'width:100%;min-height:430px;font-family:monospace',
                            'wrap': 'off' }, result.content),
                        E('div', { 'class': 'right' }, E('button', {
                            'type': 'button', 'class': 'btn', 'click': ui.hideModal
                        }, _('Close')))
                    ], 'wide');
                });
            });
        }));
        actions.appendChild(btn(_('Test and apply safely'), 'positive', function () {
            const delta = snapshot();
            if (!Object.keys(delta).length) return notify(_('No modified fields.'), true);
            if (!window.confirm(_('Test the merged configuration, save these options and restart Nikki RS? Failed startup triggers best-effort rollback.')))
                return;
            return nikki.settingsDraft(module, delta, revision).then(function (draft) {
                if (!draft.success) throw new Error(draft.error || _('Could not generate draft'));
                return nikki.configApply(module, draft.content, revision).then(function (result) {
                    if (!result.success)
                        throw new Error(_('Apply failed: ') + (result.status || 'FAILED') +
                            (result.status === 'ROLLED_BACK' ? ' — ' + _('Previous settings restored.') : ''));
                    return reload().then(function () {
                        notify(_('Settings applied; the restarted core passed its service health check.'), true);
                    });
                });
            });
        }));
        return E('div', { 'class': 'cbi-map' }, [
            E('h2', {}, _('Clash Configuration Center')),
            E('p', {}, _('Common clash-rs settings with types and range validation. These values are stored as advanced YAML overrides, leaving original profiles untouched. Special policies such as eBPF/TUN exclusivity are enforced when generating the effective configuration.')),
            E('div', { 'class': 'cbi-section' }, [
                E('h3', {}, _('Configuration category')),
                selection,
                status,
                area,
                actions,
                E('p', { 'class': 'cbi-value-description' }, [
                    _('For complex providers, DNS2 upstream routing, listeners and policy groups, use '),
                    E('a', { 'href': L.url('admin/services/nikki-rs/overrides') }, _('Advanced Config')),
                    '. ', _('For ordered routing rules, use '),
                    E('a', { 'href': L.url('admin/services/nikki-rs/rules-builder') }, _('Ordered Rules')),
                    '.'
                ])
            ])
        ].map(function (node) {
            return node;
        }));
    },
    handleSave: null,
    handleSaveApply: null,
    handleReset: null
});
