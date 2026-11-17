'use strict';
'require form';
'require view';
'require uci';
'require ui';
'require tools.nikki-rs as nikki';
'require tools.nikki-diff as diff';

return view.extend({
    load: function () {
        return Promise.all([
            uci.load('nikki-rs'),
            nikki.listProfiles()
        ]);
    },
    render: function (data) {
        const profiles = Array.isArray(data[1]) ? data[1] : [];
        const subscriptions = uci.sections('nikki-rs', 'subscription');
        const activeProfile = uci.get('nikki-rs', 'config', 'profile') || '';
        let m, s, o, so;

        m = new form.Map('nikki-rs');

        s = m.section(form.NamedSection, 'config', 'config', _('Profile'));

        o = s.option(form.FileUpload, '_upload_profile', _('Upload Profile'));
        o.browser = true;
        o.enable_download = true;
        o.root_directory = nikki.profilesDir;
        o.write = function (section_id, formvalue) {
            return true;
        };

        o = s.option(form.DummyValue, '_profile_inventory', _('Profile Files'));
        o.rawhtml = true;
        o.write = function () { };
        o.cfgvalue = function () {
            const rows = profiles.map(function (profile) {
                const selected = activeProfile === 'file:' + profile.name;
                const size = Number(profile.size) || 0;
                const sizeText = size >= 1048576 ? (size / 1048576).toFixed(1) + ' MiB' :
                    size >= 1024 ? (size / 1024).toFixed(1) + ' KiB' : size + ' B';
                const editUrl = L.url('admin/services/nikki-rs/editor') +
                    '?file=' + encodeURIComponent(nikki.profilesDir + '/' + profile.name);
                return E('tr', {}, [
                    E('td', {}, E('code', {}, profile.name)),
                    E('td', {}, sizeText),
                    E('td', {}, selected ? E('span', { 'class': 'label label-success' }, _('Selected')) : _('Available')),
                    E('td', {}, E('a', { 'class': 'btn cbi-button', 'href': editUrl }, _('Open in Editor')))
                ]);
            });
            const table = E('table', { 'class': 'table cbi-section-table', 'style': 'width:100%' }, [
                E('thead', {}, E('tr', {}, [
                    E('th', {}, _('File Name')),
                    E('th', {}, _('Size')),
                    E('th', {}, _('Profile Status')),
                    E('th', {}, _('Action'))
                ])),
                E('tbody', {}, rows.length ? rows : [E('tr', {}, E('td', { 'colspan': '4' }, _('No profile files uploaded yet. Upload a YAML profile below.')))])
            ]);
            return table.outerHTML;
        };
        o.description = _('Manage local YAML profiles here. The selected profile is shown in App Config; use Open in Editor to review or edit a file.');

        o = s.option(form.Button, '_effective_diff', _('Compare selected profile with effective config'));
        o.inputstyle = 'action';
        o.description = _('Shows how current Mixin Config, mixin.yaml and Advanced Config overrides change the selected profile. This is a read-only preview.');
        o.onclick = function () {
            return nikki.profileEffectiveDiff().then(function (result) {
                if (!result.success) {
                    alert(result.error || _('Could not preview the effective profile.'));
                    return;
                }
                const lines = diff.unified(result.before, result.after, 3);
                const counts = diff.stats(lines);
                const ruleView = diff.rulesReport(result.rules_before, result.rules_after);
                const rawPanel = E('div', {
                    'style': 'display:none;max-height:62vh;overflow:auto;border:1px solid #ccc;border-radius:4px;padding:.5em;font-family:monospace;font-size:12px;white-space:pre'
                }, lines.length ? lines.map(function (line) {
                    const prefix = line.type === '@' ? '' : line.type;
                    const color = line.type === '+' ? '#1a7f37' :
                        line.type === '-' ? '#cf222e' :
                        line.type === '@' ? '#57606a' : '';
                    return E('div', { 'style': color ? 'color:' + color : '' }, prefix + line.text);
                }) : E('p', {}, _('No effective configuration changes.')));
                const rulesPanel = E('div', {
                    'style': 'max-height:62vh;overflow:auto;border:1px solid #ccc;border-radius:4px;padding:.5em'
                }, ruleView);
                const yamlTab = E('button', { 'type': 'button', 'class': 'cbi-tab', 'click': function () {
                    rawPanel.style.display = '';
                    rulesPanel.style.display = 'none';
                    this.classList.add('active');
                    rulesTab.classList.remove('active');
                } }, _('YAML diff'));
                const rulesTab = E('button', { 'type': 'button', 'class': 'cbi-tab active', 'click': function () {
                    rawPanel.style.display = 'none';
                    rulesPanel.style.display = '';
                    this.classList.add('active');
                    yamlTab.classList.remove('active');
                } }, _('Rules view'));
                ui.showModal(_('Effective profile changes'), [
                    E('p', {}, result.note || ''),
                    E('p', {}, _('Added lines') + ': ' + counts.added + ' · ' + _('Removed lines') + ': ' + counts.removed),
                    E('p', { 'class': 'cbi-value-description' },
                        _('The diff may contain proxy credentials. Do not share it.')),
                    E('div', { 'class': 'cbi-tabmenu' }, [yamlTab, rulesTab]),
                    rulesPanel, rawPanel,
                    E('div', { 'class': 'right', 'style': 'margin-top:.75em' }, E('button', {
                        'type': 'button', 'class': 'btn', 'click': ui.hideModal
                    }, _('Close')))
                ], 'wide');
            }).catch(function (error) {
                alert(_('Profile comparison failed: ') + String(error));
            });
        };

        s = m.section(form.GridSection, 'subscription', _('Subscription'));
        s.addremove = true;
        s.anonymous = true;
        s.sortable = true;
        s.modaltitle = _('Edit Subscription');

        o = s.option(form.Value, 'name', _('Subscription Name'));
        o.rmempty = false;

        o = s.option(form.Value, 'used', _('Used'));
        o.modalonly = false;
        o.optional = true;
        o.readonly = true;

        o = s.option(form.Value, 'total', _('Total'));
        o.modalonly = false;
        o.optional = true;
        o.readonly = true;

        o = s.option(form.Value, 'expire', _('Expire At'));
        o.modalonly = false;
        o.optional = true;
        o.readonly = true;

        o = s.option(form.Value, 'update', _('Last Successful Update'));
        o.modalonly = false;
        o.optional = true;
        o.readonly = true;

        o = s.option(form.Value, 'last_attempt', _('Last Update Attempt'));
        o.modalonly = true;
        o.optional = true;
        o.readonly = true;

        o = s.option(form.DummyValue, '_update_status', _('Update Status'));
        o.modalonly = false;
        o.cfgvalue = function (section_id) {
            const success = uci.get('nikki-rs', section_id, 'success');
            const error = uci.get('nikki-rs', section_id, 'error');
            const label = success === '1' ? _('Available') : error ? _('Failed') : _('Not updated');
            return label;
        };

        o = s.option(form.Value, 'error', _('Last Update Error'));
        o.modalonly = false;
        o.optional = true;
        o.readonly = true;
        o.width = '36%';

        o = s.option(form.Button, 'update_subscription');
        o.editable = true;
        o.inputstyle = 'positive';
        o.inputtitle = _('Update');
        o.modalonly = false;
        o.onclick = function (_, section_id) {
            return nikki.updateSubscription(section_id).then(function (result) {
                if (!result || !result.success) {
                    ui.addNotification(null, E('p', {}, result && result.error ?
                        result.error : _('Update failed. Check the subscription status and Nikki RS logs.')), 'danger');
                    window.setTimeout(function () { window.location.reload(); }, 1500);
                    return;
                }
                window.location.reload();
            }).catch(function (error) {
                ui.addNotification(null, E('p', {}, _('Could not update subscription: ') + String(error)), 'danger');
            });
        };

        o = s.option(form.Value, 'info_url', _('Subscription Info Url'));
        o.modalonly = true;

        o = s.option(form.Value, 'url', _('Subscription Url'));
        o.modalonly = true;
        o.rmempty = false;

        o = s.option(form.Value, 'user_agent', _('User Agent'));
        o.default = 'clash';
        o.modalonly = true;
        o.rmempty = false;
        o.value('clash');
        o.value('clash.meta');
        o.value('mihomo');
        o.value('clash-rs');

        o = s.option(form.ListValue, 'prefer', _('Prefer'));
        o.default = 'remote';
        o.modalonly = true;
        o.rmempty = false;
        o.value('remote', _('Remote'));
        o.value('local', _('Local'));

        return m.render();
    }
});
