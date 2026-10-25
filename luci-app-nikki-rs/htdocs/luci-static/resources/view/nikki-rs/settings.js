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

const existingMixinNote = _('These options are already provided by Mixin Config. Use the existing page instead of editing duplicate controls here.');
const sections = [
    {
        id: 'core',
        label: _('Core Settings'),
        tabs: [
            { id: 'general', label: _('General'), fieldIds: ['routing-mark'],
                page: 'mixin', actionLabel: _('Open Mixin Config'),
                description: _('Mode, log level, IPv6 and QUIC are already configured in Mixin Config.') },
            { id: 'inbound', label: _('Inbound'), fieldIds: ['bind-address'],
                page: 'mixin', actionLabel: _('Open Mixin Config'),
                description: _('LAN access and proxy listener ports are already configured in Mixin Config.') },
            { id: 'cache', label: _('Cache'), fieldIds: [
                'profile.store-selected',
                'profile.store-fake-ip',
                'profile.store-smart-stats'
            ] },
            { id: 'performance', label: _('Performance'), fieldIds: ['experimental.tcp-buffer-size'] }
        ]
    },
    {
        id: 'network',
        label: _('DNS & Network'),
        tabs: [
            { id: 'dns', label: _('DNS'), page: 'mixin', actionLabel: _('Open Mixin Config'),
                description: existingMixinNote },
            { id: 'dns2', label: _('DNS2'), page: 'mixin', actionLabel: _('Open Mixin Config'),
                description: existingMixinNote },
            { id: 'tun', label: _('TUN'), page: 'mixin', actionLabel: _('Open Mixin Config'),
                description: existingMixinNote },
            { id: 'sniffer', label: _('Sniffer'), page: 'mixin', actionLabel: _('Open Mixin Config'),
                description: existingMixinNote }
        ]
    },
    {
        id: 'resources',
        label: _('Policies & Resources'),
        tabs: [
            { id: 'proxy', label: _('Proxy Config'), page: 'proxy', actionLabel: _('Open Proxy Config'),
                description: _('Proxy routing and access control are already available on the Proxy Config page.') },
            { id: 'groups', label: _('Proxy Groups & Providers'), page: 'overrides',
                actionLabel: _('Open Advanced Config'),
                description: _('Use Advanced Config to edit clash-rs proxy groups, providers, hosts and custom YAML.') },
            { id: 'rules', label: _('Ordered Rules'), page: 'rules-builder',
                actionLabel: _('Open Ordered Rules'),
                description: _('Create and reorder routing rules in the dedicated Ordered Rules page.') },
            { id: 'ui-geo', label: _('Controller UI & Geo Data'), page: 'mixin',
                actionLabel: _('Open Mixin Config'),
                description: _('Dashboard and Geo database settings are already available in Mixin Config.') }
        ]
    }
];

const pagePaths = {
    mixin: 'admin/services/nikki-rs/mixin',
    proxy: 'admin/services/nikki-rs/proxy',
    overrides: 'admin/services/nikki-rs/overrides',
    'rules-builder': 'admin/services/nikki-rs/rules-builder'
};

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
        let panels = {};
        let loadError = '';
        let busy = false;
        let activeSectionId = 'core';
        const activeTabIds = { core: 'general', network: 'dns', resources: 'proxy' };
        const sectionTabs = E('div', {
            'role': 'tablist',
            'aria-label': _('Configuration sections'),
            'style': 'display:flex;gap:.35em;flex-wrap:wrap;border-bottom:1px solid var(--border-color-low,#aaa);margin:.8em 0'
        });
        const detailTabs = E('div', {
            'role': 'tablist',
            'aria-label': _('Settings categories'),
            'style': 'display:flex;gap:.35em;flex-wrap:wrap;border-bottom:1px solid var(--border-color-low,#aaa);margin:.6em 0 1em'
        });
        const area = E('div', { 'class': 'cbi-section' });
        const status = E('p', { 'class': 'cbi-value-description' });
        const actions = E('div', { 'style': 'display:flex;gap:.6em;flex-wrap:wrap;margin:1em 0' });
        const dirty = function () { return Object.keys(pending).length > 0; };
        const currentSection = function () {
            return sections.find(function (section) { return section.id === activeSectionId; }) || sections[0];
        };
        const currentTab = function () {
            const section = currentSection();
            return section.tabs.find(function (tab) { return tab.id === activeTabIds[section.id]; }) || section.tabs[0];
        };
        const setBusy = function (value) {
            busy = value;
            [sectionTabs, detailTabs, actions].forEach(function (container) {
                Array.from(container.querySelectorAll('button')).forEach(function (button) {
                    button.disabled = value;
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
        function tabButton(label, selected, callback) {
            return E('button', {
                'type': 'button',
                'role': 'tab',
                'aria-selected': selected ? 'true' : 'false',
                'class': 'btn cbi-button',
                'style': 'border:0;border-bottom:3px solid ' +
                    (selected ? 'var(--accent-color,#7653c7)' : 'transparent') +
                    ';border-radius:0;background:transparent;padding:.65em 1em;cursor:pointer',
                'click': callback
            }, label);
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
            controls.push(E('code', { 'style': 'font-size:.85em' }, field.path));
            return E('div', {
                'style': 'display:grid;grid-template-columns:minmax(150px,1fr) minmax(240px,2fr);gap:.7em;align-items:start;padding:.65em 0;border-bottom:1px solid var(--border-color-low,#ddd)'
            }, [
                E('label', { 'for': inputId, 'style': 'font-weight:600' }, field.label),
                E('div', { 'style': 'display:flex;gap:.8em;align-items:center;flex-wrap:wrap' }, controls)
            ]);
        }
        function makeFieldPanel(tab) {
            const rows = [];
            tab.fieldIds.forEach(function (id) {
                if (fieldsById[id]) rows.push(fieldRow(fieldsById[id]));
            });
            const content = [];
            if (tab.description)
                content.push(E('p', { 'class': 'cbi-value-description' }, tab.description));
            if (rows.length)
                content.push(E('div', { 'class': 'cbi-section' }, rows));
            else
                content.push(E('p', {}, loadError || _('No unique settings are available in this category.')));
            if (tab.page)
                content.push(E('a', {
                    'class': 'btn cbi-button cbi-button-action',
                    'href': L.url(pagePaths[tab.page])
                }, tab.actionLabel));
            return E('div', {}, content);
        }
        function makeLinkPanel(tab) {
            return E('div', { 'class': 'cbi-section' }, [
                E('h3', {}, tab.label),
                E('p', { 'class': 'cbi-value-description' }, tab.description),
                E('a', {
                    'class': 'btn cbi-button cbi-button-action',
                    'href': L.url(pagePaths[tab.page])
                }, tab.actionLabel)
            ]);
        }
        function renderNavigation() {
            sectionTabs.replaceChildren(...sections.map(function (section) {
                return tabButton(section.label, section.id === activeSectionId, function () {
                    activeSectionId = section.id;
                    renderNavigation();
                    renderPanel();
                });
            }));
            const section = currentSection();
            detailTabs.replaceChildren(...section.tabs.map(function (tab) {
                return tabButton(tab.label, tab.id === activeTabIds[section.id], function () {
                    activeTabIds[section.id] = tab.id;
                    renderNavigation();
                    renderPanel();
                });
            }));
        }
        function renderPanel() {
            const section = currentSection();
            const tab = currentTab();
            const key = section.id + ':' + tab.id;
            const panel = panels[key] || E('p', {}, _('Could not load settings'));
            area.replaceChildren(panel);
            actions.hidden = !tab.fieldIds && !dirty();
            mark();
        }
        function build(response) {
            revision = '';
            pending = {};
            fieldsById = {};
            fieldValues = {};
            panels = {};
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
            sections.forEach(function (section) {
                section.tabs.forEach(function (tab) {
                    panels[section.id + ':' + tab.id] = tab.fieldIds ?
                        makeFieldPanel(tab) : makeLinkPanel(tab);
                });
            });
            renderNavigation();
            renderPanel();
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
            E('h2', {}, _('Clash-RS Configuration Center')),
            E('p', {}, _('Configure clash-rs options that are not already exposed by the original Nikki RS pages. The controls below use the installed schema and range validation. Existing Mixin, Proxy and eBPF settings are linked rather than duplicated; use Advanced Config for other Clash modules.')),
            E('p', { 'class': 'cbi-value-description' }, _('Previously saved YAML overrides are preserved. Review Advanced Config if an older override still takes precedence.')),
            E('div', { 'class': 'cbi-section' }, [
                sectionTabs,
                detailTabs,
                status,
                area,
                actions,
                E('p', { 'class': 'cbi-value-description' }, [
                    _('Unmodified values continue to inherit from the selected profile or Mixin Config. For proxy groups, providers and custom YAML, use '),
                    E('a', { 'href': L.url('admin/services/nikki-rs/overrides') }, _('Advanced Config')),
                    '. ', _('For ordered routing rules, use '),
                    E('a', { 'href': L.url('admin/services/nikki-rs/rules-builder') }, _('Ordered Rules')),
                    '.'
                ])
            ])
        ]);
    },
    handleSave: null,
    handleSaveApply: null,
    handleReset: null
});
