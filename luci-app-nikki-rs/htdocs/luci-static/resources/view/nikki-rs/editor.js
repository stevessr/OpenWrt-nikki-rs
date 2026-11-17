'use strict';
'require form';
'require view';
'require uci';
'require fs';
'require ui';
'require tools.nikki-rs as nikki';
'require tools.nikki-diff as diff';

return view.extend({
    load: function () {
        return Promise.all([
            uci.load('nikki-rs'),
            nikki.listProfiles(),
        ]);
    },
    render: function (data) {
        const subscriptions = uci.sections('nikki-rs', 'subscription');
        const profiles = data[1];
        const requestedFile = new URLSearchParams(window.location.search).get('file');
        const selectedProfile = profiles.find(function (profile) {
            return requestedFile === nikki.profilesDir + '/' + profile.name;
        });

        let m, s, o;

        m = new form.Map('nikki-rs');

        s = m.section(form.NamedSection, 'editor', 'editor', _('Editor'));
        s.description = _('Configuration edits are validated and backed up before saving. The generated startup profile is recreated on service restart; edit its source profile or mixin for persistent changes.');

        o = s.option(form.ListValue, '_file', _('Choose File'));
        o.optional = true;

        for (const profile of profiles) {
            o.value(nikki.profilesDir + '/' + profile.name, _('File:') + profile.name);
        };

        for (const subscription of subscriptions) {
            o.value(nikki.subscriptionsDir + '/' + subscription['.name'] + '.yaml', _('Subscription:') + subscription.name);
        };

        for (const module of ['general', 'dns', 'dns2', 'proxy-groups', 'proxy-providers',
            'rule-providers', 'rules', 'listeners', 'inbound-providers', 'tun', 'sniffer',
            'hosts', 'geodata', 'custom']) {
            o.value(nikki.homeDir + '/overrides/' + module + '.yaml',
                _('Advanced Config') + ': ' + module);
        };

        o.value(nikki.mixinFilePath, _('File for Mixin'));
        o.value(nikki.runProfilePath, _('Profile for Startup'));
        o.value(nikki.blackFilterPath, _('Black Filter File'));
        o.value(nikki.fakeIpFilterPath, _('Fake IP Filter File'));
        o.value(nikki.fallbackFilterPath, _('Fallback Filter File'));
        o.value(nikki.proxyWhitelistPath, _('Proxy Whitelist File (IPv4)'));
        o.value(nikki.proxyWhitelist6Path, _('Proxy Whitelist File (IPv6)'));

        o.write = function (section_id, formvalue) {
            return true;
        };
        o.onchange = function (event, section_id, value) {
            return L.resolveDefault(fs.read_direct(value), '').then(function (content) {
                m.lookupOption('_file_content', section_id)[0].getUIElement(section_id).setValue(content);
            });
        };

        o = s.option(form.TextValue, '_file_content',);
        o.rows = 25;
        o.wrap = false;
        o.rmempty = false;
        o.write = function (section_id, formvalue) {
            const path = m.lookupOption('_file', section_id)[0].formvalue(section_id);
            return nikki.saveConfig(path, formvalue).then(function (result) {
                if (!result.success) throw new Error(result.error || _('Configuration could not be saved'));
            });
        };

        o = s.option(form.Button, '_validate', _('Validate Before Saving'));
        o.inputstyle = 'action';
        o.onclick = function (_, section_id) {
            const path = m.lookupOption('_file', section_id)[0].formvalue(section_id);
            const content = m.lookupOption('_file_content', section_id)[0].formvalue(section_id);
            return nikki.validateConfig(path, content).then(function (result) {
                ui.addNotification(null, E('p', {}, result.success ?
                    _('Configuration syntax is valid.') : (result.error || _('Validation failed'))),
                    result.success ? 'info' : 'danger');
            });
        };

        o = s.option(form.Button, '_diff', _('Compare effective configuration'));
        o.inputstyle = 'action';
        o.onclick = function (ev, section_id) {
            const path = m.lookupOption('_file', section_id)[0].formvalue(section_id);
            const content = m.lookupOption('_file_content', section_id)[0].formvalue(section_id);
            return nikki.editorDiff(path, content).then(function (result) {
                if (!result.success) {
                    ui.addNotification(null, E('p', {},
                        result.error || _('Comparison failed')), 'danger');
                    return;
                }
                const lines = diff.unified(result.before, result.after, 3);
                if (lines.length === 0) {
                    ui.addNotification(null, E('p', {},
                        _('No effective configuration changes.')), 'info');
                    return;
                }
                const counts = diff.stats(lines);
                const ruleReport = diff.rulesReport(result.rules_before, result.rules_after);
                const tabbar = E('div', { 'class': 'cbi-tabmenu' }, [
                    E('button', { 'type': 'button', 'class': 'cbi-tab', 'click': function () {
                        rawPanel.style.display = '';
                        rulesPanel.style.display = 'none';
                        this.classList.add('active');
                        rulesTab.classList.remove('active');
                    } }, _('YAML diff')),
                    E('button', { 'type': 'button', 'class': 'cbi-tab', 'click': function () {
                        rawPanel.style.display = 'none';
                        rulesPanel.style.display = '';
                        this.classList.add('active');
                        rawTab.classList.remove('active');
                    } }, _('Rules view'))
                ]);
                const rawTab = tabbar.children[0];
                const rulesTab = tabbar.children[1];
                rawTab.classList.add('active');
                const body = lines.map(function (line) {
                    const prefix = line.type === '@' ? '' : line.type;
                    const color = line.type === '+' ? '#1a7f37' :
                        line.type === '-' ? '#cf222e' :
                        line.type === '@' ? '#57606a' : '';
                    return E('div', { style: color ? 'color:' + color : '' },
                        prefix + line.text);
                });
                const rawPanel = E('div', {
                    style: 'max-height:65vh;overflow:auto;border:1px solid #ccc;border-radius:4px;padding:.5em;font-family:monospace;font-size:12px;white-space:pre'
                }, body);
                const rulesPanel = E('div', {
                    style: 'display:none;max-height:65vh;overflow:auto;border:1px solid #ccc;border-radius:4px;padding:.5em'
                }, ruleReport);
                const rulesAvailable = result.rules_before && result.rules_after;
                if (!rulesAvailable) {
                    tabbar.children[1].disabled = true;
                    tabbar.children[1].title = _('No rule-level comparison is available for this file.');
                }
                ui.showModal(_('Effective configuration comparison'), [
                    E('p', {}, result.note || ''),
                    E('p', {}, _('Added lines') + ': ' + counts.added + '  ' +
                        _('Removed lines') + ': ' + counts.removed),
                    E('p', { 'class': 'cbi-value-description' },
                        _('The effective configuration may contain proxy credentials. Do not share this view.')),
                    tabbar, rawPanel, rulesPanel,
                    E('div', { 'class': 'right', 'style': 'margin-top:.75em' }, [
                        E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close'))
                    ])
                ], 'wide');
            });
        };

        o = s.option(form.Button, '_history', _('History / Restore'));
        o.inputstyle = 'action';
        o.onclick = function (_, section_id) {
            const path = m.lookupOption('_file', section_id)[0].formvalue(section_id);
            return nikki.listConfigBackups(path).then(function (result) {
                const entries = result.backups || [];
                const rows = entries.map(function (backup) {
                    return E('div', { style: 'display:flex;align-items:center;gap:1em;margin:.5em 0' }, [
                        E('code', {}, backup),
                        E('button', {
                            'class': 'btn',
                            'click': function () {
                                if (!window.confirm(_('Restore this configuration revision?'))) return;
                                nikki.restoreConfig(path, backup).then(function (result) {
                                    if (!result.success) {
                                        ui.addNotification(null, E('p', {}, _('Restore failed')), 'danger');
                                        return;
                                    }
                                    ui.hideModal();
                                    window.location.reload();
                                });
                            }
                        }, _('Restore'))
                    ]);
                });
                ui.showModal(_('Configuration History'), [
                    E('p', {}, _('Only the most recent 10 saved revisions are retained.')),
                    entries.length ? E('div', {}, rows) : E('p', {}, _('No backups available.')),
                    E('div', { 'class': 'right' }, [
                        E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Close'))
                    ])
                ]);
            });
        };

        return m.render().then(function (node) {
            if (!selectedProfile)
                return node;
            const path = nikki.profilesDir + '/' + selectedProfile.name;
            return fs.read_direct(path).then(function (content) {
                const fileOption = m.lookupOption('_file', 'editor')[0];
                const contentOption = m.lookupOption('_file_content', 'editor')[0];
                fileOption.getUIElement('editor').setValue(path);
                contentOption.getUIElement('editor').setValue(content || '');
                return node;
            });
        });
    },
    handleSaveApply: function (ev, mode) {
        return this.handleSave(ev).then(function () {
            return mode === '0' ? nikki.reload() : nikki.restart();
        });
    },
    handleReset: null
});
