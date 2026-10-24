'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require tools.nikki-rs as nikki';

function notify(message, isError) {
    ui.addNotification(null, E('p', {}, message), isError ? 'danger' : 'info');
}

return view.extend({
    load: function () {
        return Promise.all([uci.load('nikki-rs'), nikki.coreStatus()]);
    },
    render: function (data) {
        const status = data[1].info || _('Core status unavailable');
        let m = new form.Map('nikki-rs', _('Core Management'),
            _('Update clash-rs independently of the firmware package. The packaged core is kept as a fallback. An upgrade tests the new core before activation and restores the old version if the running service fails to restart.'));
        let s = m.section(form.NamedSection, 'core_update', 'core_update', _('Core Update'));
        let o = s.option(form.DummyValue, '_status', _('Current Core'));
        o.cfgvalue = function () {
            return E('pre', { style: 'white-space: pre-wrap; word-break: break-all' }, status);
        };

        o = s.option(form.ListValue, 'variant', _('Core Variant'));
        o.value('minimal', _('Minimal (low memory)'));
        o.value('standard', _('Standard (more protocols)'));
        o.default = 'minimal';
        o.rmempty = false;

        o = s.option(form.Value, 'tag', _('Release Tag'));
        o.default = 'latest';
        o.placeholder = 'latest';
        o.rmempty = false;
        o.description = _('Use latest to follow official stable releases or enter an exact upstream tag such as v0.20.23-alpha.');

        o = s.option(form.Flag, 'auto_update', _('Automatic Core Update'));
        o.default = '0';
        o.rmempty = false;
        o.description = _('Disabled by default. Scheduled updates use the latest official release.');

        o = s.option(form.Value, 'cron', _('Update Schedule (cron)'));
        o.default = '15 4 * * 0';
        o.rmempty = false;
        o.depends('auto_update', '1');

        o = s.option(form.Button, '_update', _('Install / Update Core'));
        o.inputstyle = 'positive';
        o.onclick = function () {
            const variant = m.lookupOption('variant', 'core_update')[0].formvalue('core_update') || 'minimal';
            const tag = m.lookupOption('tag', 'core_update')[0].formvalue('core_update') || 'latest';
            return m.save().then(() => nikki.coreUpdate(variant, tag)).then(function (result) {
                if (!result.success) {
                    notify(_('Core update failed. The previous core was preserved; see /etc/nikki-rs/core/update.log.'), true);
                    return;
                }
                notify(_('Core update completed.'));
                window.location.reload();
            });
        };

        o = s.option(form.Button, '_rollback', _('Rollback Core'));
        o.inputstyle = 'negative';
        o.description = _('Restore the previous downloaded core, or remove the override to use the packaged binary.');
        o.onclick = function () {
            if (!window.confirm(_('Rollback to the previous core?'))) return Promise.resolve();
            return nikki.coreRollback().then(function (result) {
                if (!result.success) {
                    notify(_('Rollback failed. Check the service logs.'), true);
                    return;
                }
                notify(_('Rollback completed.'));
                window.location.reload();
            });
        };

        return m.render();
    }
});
