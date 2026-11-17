'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require poll';
'require tools.nikki-rs as nikki';
'require tools.nikki-cron as cron';

return view.extend({
    load: function () {
        return Promise.all([uci.load('nikki-rs'), nikki.coreStatus()]);
    },
    render: function (data) {
        if (!uci.get('nikki-rs', 'core_update'))
            uci.add('nikki-rs', 'core_update', 'core_update');
        const status = E('pre', {style:'white-space:pre-wrap;overflow-wrap:anywhere'}, data[1].info || '');
        const log = E('pre', {style:'white-space:pre-wrap;overflow-wrap:anywhere;max-height:24em;overflow:auto'}, data[1].log || _('No update log yet.'));
        const feedback = E('p', {'role':'status'}, '');
        let running = !!data[1].running;
        const buttons = [];
        const busy = function (value) {
            running = value;
            buttons.forEach(function (button) { button.disabled = value; });
        };
        const refresh = function () {
            return nikki.coreStatus().then(function (result) {
                status.textContent = result.info || '';
                log.textContent = result.log || _('No update log yet.');
                const wasRunning = running;
                busy(!!result.running);
                if (wasRunning && !result.running)
                    feedback.textContent = /state=success/.test(result.info || '') ? _('Core operation completed.') :
                        _('Core operation failed. See the update log below.');
            }).catch(function (error) { feedback.textContent = String(error); });
        };
        const m = new form.Map('nikki-rs', _('Core Management'),
            _('Update clash-rs independently of the firmware package. The packaged core is kept as a fallback. An upgrade tests the new core before activation and restores the old version if the running service fails to restart.'));
        const s = m.section(form.NamedSection, 'core_update', 'core_update', _('Core Update'));
        let o = s.option(form.ListValue, 'variant', _('Core Variant'));
        o.value('minimal', _('Minimal (low memory)'));
        o.value('standard', _('Standard (more protocols)'));
        o.default = 'minimal'; o.rmempty = false;
        o = s.option(form.Value, 'tag', _('Release Tag'));
        o.default = 'latest'; o.rmempty = false;
        o.validate = function (_, value) {
            return /^(latest|v[A-Za-z0-9._-]+)$/.test(value) || _('Enter latest or an exact release tag starting with v.');
        };
        o.description = _('Use latest or an exact release tag. Downloads try the local proxy first, then a direct connection.');
        o = s.option(form.Flag, 'auto_update', _('Automatic Core Update'));
        o.default = '0'; o.rmempty = false;
        o = s.option(form.Value, 'cron', _('Update Schedule (cron)'));
        o.default = '15 4 * * 0'; o.validate = cron.validate;
        o.depends('auto_update', '1'); o.rmempty = false;
        const start = function (rollback) {
            busy(true);
            feedback.textContent = _('Starting core operation…');
            const variant = m.lookupOption('variant', 'core_update')[0].formvalue('core_update') || 'minimal';
            const tag = m.lookupOption('tag', 'core_update')[0].formvalue('core_update') || 'latest';
            if (!/^(latest|v[A-Za-z0-9._-]+)$/.test(tag)) {
                busy(false); feedback.textContent = _('Invalid release tag'); return;
            }
            return (rollback ? nikki.coreRollback() : nikki.coreUpdate(variant, tag)).then(function (result) {
                if (!result.success) {
                    busy(false);
                    feedback.textContent = result.error || _('Could not start core operation. Another operation may be running.');
                } else feedback.textContent = _('Core operation running. Progress and download errors appear below.');
                return refresh();
            }).catch(function (error) { busy(false); feedback.textContent = String(error); });
        };
        const update = E('button', {'class':'btn cbi-button-positive','type':'button','click':function () { return start(false); }}, _('Install / Update Core'));
        const rollback = E('button', {'class':'btn cbi-button-negative','type':'button','click':function () { return start(true); }}, _('Rollback Core'));
        const reload = E('button', {'class':'btn','type':'button','click':refresh}, _('Refresh status'));
        buttons.push(update, rollback); busy(running);
        poll.add(refresh, 3);
        return m.render().then(function (node) {
            node.appendChild(E('section', {'class':'cbi-section'}, [
                E('h3', {}, _('Current Core')), status,
                E('div', {style:'display:flex;gap:.6em;flex-wrap:wrap'}, [update, rollback, reload]),
                feedback, E('h3', {}, _('Update log')), log
            ]));
            return node;
        });
    }
});
