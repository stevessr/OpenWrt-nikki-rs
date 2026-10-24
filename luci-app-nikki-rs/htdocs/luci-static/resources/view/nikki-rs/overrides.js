'use strict';
'require view';
'require fs';
'require ui';
'require tools.nikki-rs as nikki';

const modules = [
    { id: 'general', label: _('General'), hint: _('Log level, mode, ports, IPv6 and general Clash options') },
    { id: 'dns', label: _('DNS'), hint: _('Legacy DNS, Fake IP, policy and upstreams') },
    { id: 'dns2', label: _('DNS2'), hint: _('Tagged upstream pools and DNS2 request/response routing') },
    { id: 'proxy-groups', label: _('Proxy Groups'), hint: _('Prepend custom selector or test groups without editing a subscription') },
    { id: 'proxy-providers', label: _('Proxy Providers'), hint: _('Generic local or remote proxy provider mappings; no vendor-specific integrations') },
    { id: 'rule-providers', label: _('Rule Providers'), hint: _('Rule-set endpoints, behavior, format and refresh settings') },
    { id: 'listeners', label: _('Listeners'), hint: _('HTTP, SOCKS, mixed, redirect, TProxy and other inbound listeners') },
    { id: 'inbound-providers', label: _('Inbound Providers'), hint: _('Dynamic inbound listener providers (clash-rs extension)') },
    { id: 'hosts', label: _('Hosts'), hint: _('Static hosts mapping and DNS host overrides') },
    { id: 'geodata', label: _('Geo / Databases'), hint: _('GeoIP, Geosite and geodata path settings') },
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
        return nikki.configSnapshot(pathFor('general'));
    },
    render: function (initial) {
        let activeModule = 'general';
        let savedContent = initial && initial.success ? initial.content : '{}\n';
        let savedRevision = initial && initial.success ? initial.revision : '';
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
        }, savedContent);
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
                return nikki.configSnapshot(pathFor(selected)).then(function (snapshot) {
                    if (!snapshot.success) throw new Error(snapshot.error || _('Cannot read module'));
                    if (selector.value === selected) {
                        editor.value = snapshot.content;
                        savedContent = snapshot.content;
                        savedRevision = snapshot.revision;
                        activeModule = selected;
                        dirtyStatus.textContent = _('All changes saved');
                        history.replaceChildren();
                    }
                }).catch(function (error) {
                    selector.value = activeModule;
                    throw error;
                });
            });
        });

        const save = function () {
            const content = editor.value;
            const path = pathFor(selector.value);
            if (!savedRevision) throw new Error(_('Reload this module before saving'));
            return nikki.saveConfigRevision(path, content, savedRevision).then(function (result) {
                if (!result.success) throw new Error(result.error || _('Save failed'));
                return nikki.configSnapshot(path).then(function (snapshot) {
                    if (!snapshot.success) throw new Error(snapshot.error || _('Cannot refresh saved module'));
                    savedContent = snapshot.content;
                    savedRevision = snapshot.revision;
                    dirtyStatus.textContent = _('All changes saved');
                    notify(_('Module saved. Restart Nikki RS after checking the preview to apply it.'), true);
                });
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
        controls.appendChild(makeButton(_('Review configuration changes'), 'action', function () {
            return nikki.overrideAnalyze(selector.value, editor.value).then(function (result) {
                if (!result.success || !result.report) {
                    notify(result.error || _('Configuration impact analysis failed'), false);
                    return;
                }
                const report = result.report;
                const changes = Array.isArray(report.changed_sections) ? report.changed_sections : [];
                const before = report.before || {};
                const after = report.after || {};
                const metrics = [
                    [_('Rules'), 'rules'],
                    [_('Proxy nodes'), 'proxies'],
                    [_('Proxy groups'), 'groups'],
                    [_('Rule providers'), 'rule_providers']
                ];
                const rows = metrics.map(function (metric) {
                    return E('tr', {}, [
                        E('td', {}, metric[0]),
                        E('td', {}, String(before[metric[1]] ?? 0)),
                        E('td', {}, String(after[metric[1]] ?? 0))
                    ]);
                });
                const warnings = [];
                if ((after.duplicate_rules || 0) > 0)
                    warnings.push(_('Duplicate rules detected: ') + after.duplicate_rules);
                if ((after.duplicate_proxy_names || 0) > 0)
                    warnings.push(_('Duplicate proxy names detected: ') + after.duplicate_proxy_names);
                if ((after.duplicate_group_names || 0) > 0)
                    warnings.push(_('Duplicate proxy group names detected: ') + after.duplicate_group_names);
                if (!after.dns && !after.dns2)
                    warnings.push(_('Neither DNS nor DNS2 is enabled in the effective profile.'));
                if (after.ebpf && (after.tun || after.tun_listeners > 0))
                    warnings.push(_('eBPF and TUN conflict in the effective profile.'));
                ui.showModal(_('Configuration change review'), [
                    E('p', {}, _('Compared the saved effective profile with the proposed unsaved module change. Values, node credentials and rule text are not included.')),
                    E('p', {}, [
                        E('strong', {}, _('Changed top-level sections: ')),
                        changes.length ? changes.map(function (key, index) {
                            return E('span', {}, [
                                index ? ', ' : '',
                                E('code', {}, String(key))
                            ]);
                        }) : _('None')
                    ]),
                    E('table', { 'class': 'table', 'style': 'width:100%' }, [
                        E('thead', {}, E('tr', {}, [
                            E('th', {}, _('Metric')),
                            E('th', {}, _('Saved')),
                            E('th', {}, _('Proposed'))
                        ])),
                        E('tbody', {}, rows)
                    ]),
                    E('p', {}, [
                        E('strong', {}, _('eBPF: ')),
                        after.ebpf ? _('Enabled') : _('Disabled'),
                        ' · ',
                        E('strong', {}, _('TUN: ')),
                        after.tun ? _('Enabled') : _('Disabled')
                    ]),
                    warnings.length ? E('ul', {}, warnings.map(function (message) {
                        return E('li', {}, message);
                    })) : E('p', {}, _('No basic structural warnings found.')),
                    E('p', { 'class': 'cbi-value-description' },
                        _('This is a static review, not a successful clash-rs core test. Use Test with installed core for runtime validation.')),
                    E('div', { 'class': 'right' }, E('button', {
                        'type': 'button', 'class': 'btn', 'click': ui.hideModal
                    }, _('Close')))
                ], 'wide');
            });
        }));
        controls.appendChild(makeButton(_('Save module'), 'positive', save));
        controls.appendChild(makeButton(_('Save, test and apply safely'), 'positive', function () {
            if (!savedRevision) throw new Error(_('Reload this module before applying'));
            if (!window.confirm(_('This will test the merged Clash configuration, save your changes and restart Nikki RS. Connectivity may be briefly interrupted. If the restart or health check fails, the previous module will be restored. Continue?')))
                return;
            const module = selector.value;
            const path = pathFor(module);
            const content = editor.value;
            return nikki.configApply(module, content, savedRevision).then(function (result) {
                if (!result.success) {
                    if (result.status === 'ROLLED_BACK')
                        throw new Error(_('The new configuration did not start correctly. The previous module was restored and the service was restarted. Your unsaved draft is still in the editor.'));
                    if (result.status === 'ROLLBACK_FAILED')
                        throw new Error(_('Recovery was not confirmed. Check Nikki RS status and the router console immediately before making further changes.'));
                    if (result.status === 'SERVICE_NOT_RUNNING')
                        throw new Error(_('Nikki RS is not running. Start the service first, or use Save module without applying.'));
                    if (result.status === 'PREFLIGHT_FAILED')
                        throw new Error(_('The installed clash-rs core rejected the candidate configuration, or a remote provider failed to initialize. Nothing was saved.'));
                    if (result.status === 'CONFLICT')
                        throw new Error(_('The module changed on disk. Reload it before trying again.'));
                    throw new Error(_('Safe apply did not complete: ') + String(result.status || 'FAILED'));
                }
                return nikki.configSnapshot(path).then(function (snapshot) {
                    if (!snapshot.success) throw new Error(_('Applied, but could not refresh the editor revision.'));
                    savedContent = snapshot.content;
                    savedRevision = snapshot.revision;
                    editor.value = snapshot.content;
                    dirtyStatus.textContent = _('All changes saved');
                    notify(_('Configuration applied and the restarted Nikki RS service passed its health check.'), true);
                });
            });
        }));

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
                                        return nikki.configSnapshot(path).then(function (snapshot) {
                                            if (!snapshot.success) throw new Error(_('Cannot reload restored module'));
                                            if (path === pathFor(selector.value)) {
                                                editor.value = snapshot.content;
                                                savedContent = snapshot.content;
                                                savedRevision = snapshot.revision;
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
