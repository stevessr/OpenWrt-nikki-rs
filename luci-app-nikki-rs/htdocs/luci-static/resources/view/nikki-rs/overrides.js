'use strict';
'require view';
'require fs';
'require ui';
'require tools.nikki-rs as nikki';

const modules = [
    { id: 'general', label: _('General'), hint: _('Log level, mode, ports, IPv6 and general Clash options') },
    { id: 'dns', label: _('DNS / DNS2'), hint: _('DNS servers, Fake IP and DNS2 overrides') },
    { id: 'proxy-groups', label: _('Proxy Groups'), hint: _('Prepend custom selector or test groups without editing a subscription') },
    { id: 'rules', label: _('Rules'), hint: _('Ordered priority rules (nikki-rules prepends to subscription rules)') },
    { id: 'tun', label: _('TUN'), hint: _('TUN properties; router-managed routing flags are enforced on startup') },
    { id: 'sniffer', label: _('Sniffer'), hint: _('HTTP, TLS and QUIC sniffing settings') },
    { id: 'custom', label: _('Custom YAML'), hint: _('Other advanced clash-rs options') }
];

function notify(message, success) {
    ui.addNotification(null, E('p', {}, message), success ? 'info' : 'danger');
}

function pathFor(module) {
    return '/etc/nikki-rs/overrides/' + module + '.yaml';
}

return view.extend({
    load: function () {
        return L.resolveDefault(fs.read_direct(pathFor('general')), '{}\n');
    },
    render: function (initial) {
        let activeModule = 'general';
        let savedContent = initial || '{}\n';
        const heading = E('h2', {}, _('Advanced Clash Config'));
        const introduction = E('p', {},
            _('Manage advanced configuration as separate YAML modules. Original profiles and subscriptions are not modified. Each module overrides the selected profile and LuCI mixin; nikki-rules, nikki-proxies and nikki-proxy-groups prepend entries.'));
        const selector = E('select', { 'class': 'cbi-input-select', 'style': 'min-width: 240px' },
            modules.map(function (module) {
                return E('option', { 'value': module.id }, module.label);
            }));
        const hint = E('p', { 'class': 'cbi-value-description' }, modules[0].hint);
        const editor = E('textarea', {
            'class': 'cbi-input-textarea',
            'rows': 26,
            'wrap': 'off',
            'spellcheck': 'false',
            'style': 'width:100%;min-height:440px;font-family:monospace;resize:vertical'
        }, initial);
        const dirtyStatus = E('p', { 'class': 'cbi-value-description' }, _('All changes saved'));
        const status = E('p', { 'class': 'cbi-value-description' },
            _('Saving does not restart the proxy. Preview uses the last generated base profile; restart Nikki RS after saving to apply changes.'));
        const history = E('div', {});
        const controls = E('div', { 'style': 'display:flex;gap:.6em;flex-wrap:wrap;margin:1em 0' });
        const busy = function (running) {
            Array.from(controls.querySelectorAll('button')).forEach(function (button) {
                button.disabled = running;
            });
            selector.disabled = running;
        };
        const run = function (action) {
            busy(true);
            return Promise.resolve().then(action).catch(function (error) {
                notify(String(error), false);
            }).finally(function () {
                busy(false);
            });
        };
        editor.addEventListener('input', function () {
            dirtyStatus.textContent = editor.value === savedContent ? _('All changes saved') :
                _('Unsaved changes — save or discard before switching modules');
        });
        selector.addEventListener('change', function () {
            const selected = selector.value;
            if (editor.value !== savedContent &&
                !window.confirm(_('Discard unsaved changes in this module?'))) {
                selector.value = activeModule;
                return;
            }
            const item = modules.find(function (module) { return module.id === selected; });
            hint.textContent = item.hint;
            run(function () {
                return L.resolveDefault(fs.read_direct(pathFor(selected)), '{}\n').then(function (content) {
                    if (selector.value === selected) {
                        editor.value = content;
                        savedContent = content;
                        activeModule = selected;
                        dirtyStatus.textContent = _('All changes saved');
                        history.replaceChildren();
                    }
                });
            });
        });

        const save = function () {
            const content = editor.value;
            return nikki.saveConfig(pathFor(selector.value), content).then(function (result) {
                if (!result.success) throw new Error(result.error || _('Save failed'));
                savedContent = content;
                dirtyStatus.textContent = _('All changes saved');
                notify(_('Module saved. Restart Nikki RS after checking the preview to apply it.'), true);
            });
        };
        const makeButton = function (label, style, onclick) {
            return E('button', {
                'class': 'btn cbi-button cbi-button-' + style,
                'type': 'button',
                'click': function () { return run(onclick); }
            }, label);
        };
        controls.appendChild(makeButton(_('Validate YAML'), 'action', function () {
            return nikki.validateConfig(pathFor(selector.value), editor.value).then(function (result) {
                notify(result.success ? _('YAML mapping is valid.') :
                    (result.error || _('Invalid YAML')), result.success);
            });
        }));
        controls.appendChild(makeButton(_('Preview merged configuration'), 'action', function () {
            return nikki.overridePreview(selector.value, editor.value).then(function (result) {
                if (!result.success) {
                    notify(result.error || _('Could not produce preview'), false);
                    return;
                }
                const preview = E('textarea', {
                    'readonly': '',
                    'rows': 26,
                    'wrap': 'off',
                    'spellcheck': 'false',
                    'style': 'width:100%;min-height:450px;font-family:monospace'
                }, result.content);
                ui.showModal(_('Merged configuration preview'), [
                    E('p', {}, _('Read-only preview based on the last generated profile. The router may enforce additional TUN safety options during startup. This output can contain proxy credentials.')),
                    preview,
                    E('div', { 'class': 'right' }, E('button', {
                        'class': 'btn',
                        'click': ui.hideModal
                    }, _('Close')))
                ], 'wide');
            });
        }));
        controls.appendChild(makeButton(_('Test with installed core'), 'action', function () {
            return nikki.overrideTest(selector.value, editor.value).then(function (result) {
                notify(result.success ?
                    _('The installed clash-rs core accepted this candidate configuration.') :
                    (result.error || _('Core preflight failed')), result.success);
            });
        }));
        controls.appendChild(makeButton(_('Diagnose effective config'), 'action', function () {
            return nikki.overrideInspect(selector.value, editor.value).then(function (result) {
                if (!result.success) {
                    notify(result.error || _('Diagnostics unavailable'), false);
                    return;
                }
                const info = JSON.parse(result.info);
                const line = function (label, value) {
                    return E('div', { 'style': 'padding:.25em 0' }, [
                        E('strong', {}, label + ': '), String(value)
                    ]);
                };
                ui.showModal(_('Clash configuration diagnostics'), [
                    E('p', {}, _('Summary of the merged configuration. No proxy credentials or rule contents are shown.')),
                    line(_('Routing mode'), info.mode || _('Not specified')),
                    line(_('DNS enhanced mode'), info.dns_mode || _('Not specified')),
                    line(_('Rules'), info.rules),
                    line(_('Proxies'), info.proxies),
                    line(_('Proxy groups'), info.groups),
                    line(_('Duplicate rules'), info.duplicate_rules),
                    info.duplicate_rules > 0 ? E('p', { 'style': 'font-weight:bold' },
                        _('Duplicate routing rules were detected; consider removing redundant entries.')) : E('p', {}, _('No exact duplicate rules found.')),
                    E('div', { 'class': 'right' }, E('button', {
                        'class': 'btn', 'click': ui.hideModal
                    }, _('Close')))
                ]);
            });
        }));
        controls.appendChild(makeButton(_('Save module'), 'positive', save));
        controls.appendChild(makeButton(_('Revision history'), 'action', function () {
            const path = pathFor(selector.value);
            return nikki.listConfigBackups(path).then(function (result) {
                const revisions = result.backups || [];
                history.replaceChildren();
                if (!revisions.length) {
                    history.appendChild(E('p', {}, _('No saved revisions available.')));
                    return;
                }
                history.appendChild(E('h3', {}, _('Recent versions')));
                revisions.forEach(function (backup) {
                    history.appendChild(E('div', { 'style': 'margin:.4em 0' }, [
                        E('code', { 'style': 'margin-right:1em' }, backup),
                        E('button', {
                            'type': 'button', 'class': 'btn cbi-button',
                            'click': function () {
                                if (!window.confirm(_('Restore this revision? The current version will be backed up.'))) return;
                                run(function () {
                                    return nikki.restoreConfig(path, backup).then(function (result) {
                                        if (!result.success) throw new Error(_('Could not restore revision'));
                                        return fs.read_direct(path).then(function (content) {
                                            if (path === pathFor(selector.value)) {
                                                editor.value = content;
                                                savedContent = content;
                                                dirtyStatus.textContent = _('All changes saved');
                                            }
                                            notify(_('Revision restored. Restart to apply.'), true);
                                        });
                                    });
                                });
                            }
                        }, _('Restore'))
                    ]));
                });
            });
        }));

        return E('div', { 'class': 'cbi-map' }, [
            heading, introduction,
            E('div', { 'class': 'cbi-section' }, [
                E('h3', {}, _('Configuration module')),
                selector, hint, dirtyStatus, editor, controls, status, history
            ])
        ]);
    },
    handleSave: null,
    handleSaveApply: null,
    handleReset: null
});
