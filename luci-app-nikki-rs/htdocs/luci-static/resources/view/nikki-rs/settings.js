'use strict';
'require view';
'require ui';
'require tools.nikki-rs as nikki';

const INHERIT = '__inherit__';
const visibleFieldIds = new Set([
    'bind-address',
    'routing-mark',
    'profile.store-selected',
    'profile.store-fake-ip',
    'profile.store-smart-stats',
    'experimental.tcp-buffer-size'
]);

const categories = [
    { id: 'general', label: _('General'), fieldIds: ['routing-mark', 'bind-address'] },
    { id: 'cache', label: _('Cache'), fieldIds: [
        'profile.store-selected', 'profile.store-fake-ip', 'profile.store-smart-stats'
    ] },
    { id: 'performance', label: _('Performance'), fieldIds: ['experimental.tcp-buffer-size'] }
];

function notify(message, success) {
    ui.addNotification(null, E('p', {}, message), success ? 'info' : 'danger');
}

function editorControl(field, current, onChange) {
    let control;
    const value = current == null ? null : current;
    if (field.kind === 'bool') {
        control = E('select', { 'class': 'cbi-input-select' }, [
            E('option', { 'value': INHERIT }, _('Unmodified')),
            E('option', { 'value': 'true' }, _('Enabled')),
            E('option', { 'value': 'false' }, _('Disabled'))
        ]);
        control.value = value == null ? INHERIT : String(value);
    } else if (field.kind === 'enum') {
        control = E('select', { 'class': 'cbi-input-select' }, [
            E('option', { 'value': INHERIT }, _('Unmodified')),
            ...(field.choices || []).map(function (option) {
                return E('option', { 'value': option }, option);
            })
        ]);
        control.value = value == null ? INHERIT : String(value);
    } else if (field.kind === 'list') {
        control = E('textarea', { 'class': 'cbi-input-textarea', 'rows': 3,

            'placeholder': _('One value per line') },
        Array.isArray(value) ? value.join('\n') : '');
    } else {
        const props = {
            'class': 'cbi-input-text',
            'type': (field.kind === 'port' || field.kind === 'int') ? 'number' : 'text',

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
    if (field.kind === 'enum') return control.value;
    return control.value.trim();
}

return view.extend({
    load: function () { return nikki.settingsRead('general'); },
    render: function (initial) {
        let revision = '';
        let pending = {};
        let fieldsById = {};
        let fieldValues = {};
        let loadError = '';
        let busy = false;
        const area = E('div', { 'class': 'cbi-section' });
        const tabContainer = E('div', {}, area);
        const status = E('p', { 'class': 'cbi-value-description' });
        const actions = E('div', { 'class': 'cbi-page-actions' });
        const dirty = function () { return Object.keys(pending).length > 0; };
        const setBusy = function (value) {
            busy = value;
            [area, actions].forEach(function (container) {
                Array.from(container.querySelectorAll('button, input, select, textarea')).forEach(function (button) {
                    if (value) {
                        button.dataset.wasDisabled = button.disabled ? '1' : '0';
                        button.disabled = true;
                    } else if (button.dataset.wasDisabled != null) {
                        button.disabled = button.dataset.wasDisabled === '1';
                        delete button.dataset.wasDisabled;
                    }
                });
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
                _('Unsaved changes are waiting to be reviewed or saved.') :
                _('Choose “Unmodified” to keep the existing profile or Mixin Config value.');
        }
        function fieldRow(field) {
            const value = fieldValues[field.id];
            const explicit = value !== null && value !== undefined;
            const choice = field.kind === 'bool' || field.kind === 'enum';
            const inputId = 'nikki-setting-' + field.id.replace(/[^a-zA-Z0-9_-]/g, '-');
            let mode;
            let input;
            const handler = function () {
                if (choice && input.value === INHERIT) {
                    pending[field.id] = null;
                } else if (!choice && mode.value === 'inherit') {
                    pending[field.id] = null;
                } else {
                    try {
                        pending[field.id] = parsedValue(field, input);
                    } catch (error) {
                        // Preserve the invalid draft so save reports it without changing the source value.
                        pending[field.id] = undefined;
                    }
                }
                mark();
            };
            input = editorControl(field, value, handler);
            input.id = inputId;
            input.setAttribute('aria-label', field.label);
            const controls = [];
            if (!choice) {
                mode = E('select', {
                    'class': 'cbi-input-select',
                    'style': 'min-width:9em',
                    'aria-label': _('Change behavior for') + ' ' + field.label
                }, [
                    E('option', { 'value': 'inherit' }, _('Unmodified')),
                    E('option', { 'value': 'set' }, _('Set value'))
                ]);
                mode.value = explicit ? 'set' : 'inherit';
                input.disabled = !explicit;
                mode.addEventListener('change', function () {
                    input.disabled = mode.value !== 'set';
                    handler();
                });
                controls.push(mode);
            }
            controls.push(input);
            return E('div', {
                'class': 'cbi-value'
            }, [
                E('label', { 'for': inputId, 'class': 'cbi-value-title' }, field.label),
                E('div', { 'class': 'cbi-value-field' }, controls)
            ]);
        }
        function renderPanels() {
            tabContainer.replaceChildren(area);
            area.removeAttribute('data-initialized');
            area.replaceChildren(...categories.map(function (category) {
                return E('div', {
                    'data-tab': category.id,
                    'data-tab-title': category.label
                }, category.fieldIds.filter(function (id) {
                    return fieldsById[id];
                }).map(function (id) { return fieldRow(fieldsById[id]); }));
            }));
            if (loadError)
                area.replaceChildren(E('p', { 'class': 'alert-message warning' }, loadError));
            else
                ui.tabs.initTabGroup(Array.from(area.childNodes));
            mark();
        }
        function build(response) {
            revision = '';
            pending = {};
            fieldsById = {};
            fieldValues = {};
            loadError = '';
            if (!response || !response.success ||
                !Array.isArray(response.fields) || !response.revision) {
                loadError = response?.error || _('Could not load settings');
            } else {
                revision = response.revision;
                response.fields.forEach(function (field) {
                    if (!visibleFieldIds.has(field.id)) return;
                    fieldsById[field.id] = field;
                    fieldValues[field.id] = response.values?.[field.id];
                });
            }
            renderPanels();
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
            return nikki.settingsRead('general').then(function (result) {
                if (!result.success) throw new Error(result.error || _('Cannot refresh settings'));
                build(result);
            });
        }
        const btn = function (label, className, callback) {
            return E('button', {
                'type': 'button',
                'class': 'btn cbi-button cbi-button-' + className,
                'click': function () { return execute(callback); }
            }, label);
        };
        actions.appendChild(btn(_('Reload'), 'action', function () {
            if (dirty() && !window.confirm(_('Discard current draft?'))) return;
            return reload();
        }));
        actions.appendChild(document.createTextNode(' '));
        actions.appendChild(btn(_('Save settings'), 'positive', function () {
            const delta = snapshot();
            if (!Object.keys(delta).length) return notify(_('No modified fields.'), true);
            return nikki.settingsPatch('general', delta, revision).then(function (result) {
                if (!result.success) throw new Error(result.error || _('Save failed'));
                return reload().then(function () {
                    notify(_('Settings saved with a revision backup. Use Test and apply safely to restart Nikki RS.'), true);
                });
            });
        }));
        actions.appendChild(document.createTextNode(' '));
        actions.appendChild(btn(_('Review merged configuration'), 'action', function () {
            const delta = snapshot();
            if (!Object.keys(delta).length) return notify(_('No modified fields.'), true);
            return nikki.settingsDraft('general', delta, revision).then(function (draft) {
                if (!draft.success) throw new Error(draft.error || _('Could not generate draft'));
                return nikki.overridePreview('general', draft.content).then(function (result) {
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
        actions.appendChild(document.createTextNode(' '));
        actions.appendChild(btn(_('Test and apply safely'), 'positive', function () {
            const delta = snapshot();
            if (!Object.keys(delta).length) return notify(_('No modified fields.'), true);
            if (!window.confirm(_('Test the merged configuration, save these options and restart Nikki RS? Failed startup triggers best-effort rollback.')))
                return;
            return nikki.settingsDraft('general', delta, revision).then(function (draft) {
                if (!draft.success) throw new Error(draft.error || _('Could not generate draft'));
                return nikki.configApply('general', draft.content, revision).then(function (result) {
                    if (!result.success)
                        throw new Error(_('Apply failed: ') + (result.status || 'FAILED') +
                            (result.status === 'ROLLED_BACK' ? ' — ' + _('Previous settings restored.') : ''));
                    return reload().then(function () {
                        notify(_('Settings applied; the restarted core passed its service health check.'), true);
                    });
                });
            });
        }));
        build(initial);
        return E('div', { 'class': 'cbi-map' }, [
            E('h2', {}, _('Additional Settings')),
            E('p', {}, _('Additional clash-rs options. Existing settings remain in Mixin Config, Proxy Config and eBPF Config.')),
            E('p', { 'class': 'cbi-value-description' }, _('Previously saved YAML overrides are preserved. Review Advanced Config if an older override still takes precedence.')),
            E('div', { 'class': 'cbi-section' }, [
                status,
                tabContainer,
                E('p', { 'class': 'cbi-value-description' }, [
                    _('Unmodified values continue to inherit from the selected profile or Mixin Config. For proxy groups, providers and custom YAML, use '),
                    E('a', { 'href': L.url('admin/services/nikki-rs/overrides') }, _('Advanced Config')),
                    '.'
                ])
            ]),
            actions
        ]);
    },
    handleSave: null,
    handleSaveApply: null,
    handleReset: null
});
