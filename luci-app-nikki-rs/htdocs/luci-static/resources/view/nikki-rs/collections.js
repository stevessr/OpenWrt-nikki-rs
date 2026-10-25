'use strict';
'require view';
'require form';
'require ui';
'require tools.nikki-rs as nikki';

const definitions = {
    'proxy-groups': {
        title: _('Proxy Groups'),
        fields: [
            ['name', _('Group name'), 'text'],
            ['type', _('Strategy'), 'enum', ['select','url-test','fallback','load-balance','smart','relay']],
            ['proxies', _('Proxy/group members (one per line)'), 'lines'],
            ['use', _('Proxy providers (one per line)'), 'lines'],
            ['url', _('Health-check URL'), 'text'],
            ['interval', _('Test interval (seconds)'), 'number'],
            ['tolerance', _('Switch tolerance (ms)'), 'number'],
            ['strategy', _('Balance strategy'), 'enum', ['consistent-hashing','round-robin','sticky-session']],
            ['filter', _('Provider name regex'), 'text'],
            ['include-all', _('Include all proxies'), 'bool'],
            ['empty-fallback', _('Empty-group fallback'), 'text'],
            ['icon', _('Icon URL'), 'text']
        ],
        defaults: {name:'New Group',type:'select',proxies:['DIRECT']}
    },
    'listeners': {
        title: _('Inbound Listeners'),
        fields: [
            ['name', _('Listener name'), 'text'],
            ['type', _('Protocol'), 'enum', ['http','socks','mixed','redir','tproxy','tun']],
            ['listen', _('Listen interface / IP'), 'text'],
            ['port', _('Listening port'), 'number'],
            ['device', _('TUN device'), 'text']
        ],
        defaults: {name:'local-mixed',type:'mixed',listen:'127.0.0.1',port:7890}
    },
    'proxy-providers': {
        title: _('Generic Proxy Providers'),
        fields: [
            ['name', _('Provider ID'), 'text'],
            ['type', _('Source type'), 'enum', ['http','file']],
            ['url', _('Download URL'), 'text'],
            ['path', _('Cache/file path'), 'text'],
            ['interval', _('Refresh interval (seconds)'), 'number']
        ],
        defaults: {name:'my-proxies',type:'file',path:'./providers/proxy/my-proxies.yaml'}
    }
};

const moduleNames = Object.keys(definitions);
const mapped = { 'rule-providers':true, 'proxy-providers':true };
function inform(message, good) {
    ui.addNotification(null, E('p', {}, message), good ? 'info' : 'danger');
}
function toRows(module, value) {
    if (mapped[module]) {
        if (value == null || typeof value !== 'object' || Array.isArray(value))
            throw new Error(_('Expected a provider mapping'));
        return Object.keys(value).map(function (name) {
            if (!value[name] || typeof value[name] !== 'object' || Array.isArray(value[name]))
                throw new Error(_('Provider entry is not a mapping: ') + name);
            return Object.assign({}, value[name], {name:name});
        });
    }
    if (!Array.isArray(value)) throw new Error(_('Expected an ordered list'));
    return value.map(function (row) { return Object.assign({}, row); });
}
function toPayload(module, rows) {
    const names = new Set();
    const result = mapped[module] ? {} : [];
    rows.forEach(function (row) {
        if (!row || typeof row !== 'object' || Array.isArray(row))
            throw new Error(_('A collection record is not a mapping'));
        const name = String(row.name || '').trim();
        if (!name || name.length > 128 || /[\r\n\x00-\x1f]/.test(name))
            throw new Error(_('Every entry needs a valid name'));
        if (names.has(name)) throw new Error(_('Duplicate name: ') + name);
        names.add(name);
        if (mapped[module]) {
            const provider = Object.assign({}, row);
            delete provider.name;
            result[name] = provider;
        } else {
            result.push(Object.assign({}, row, {name:name}));
        }
    });
    return result;
}
return view.extend({
    load:function () { return nikki.collectionRead('proxy-groups'); },
    render:function (initial) {
        let module = 'proxy-groups';
        let revision = '';
        let map;
        let original = '[]';
        let loading = false;
        const selector = E('select', { 'id':'collection-module', 'class':'cbi-input-select' },
            moduleNames.map(function (name) {
                return E('option', {value:name}, definitions[name].title);
            }));
        const heading = E('h2', {}, _('Local Collections'));
        const state = E('p', {'class':'cbi-value-description'});
        const container = E('div');
        const buttons = E('div', {'class':'cbi-page-actions'});
        function getPayload() {
            const rows = map.data.sections('json', 'entry').map(function (record) {
                const row = {};
                Object.keys(record).forEach(function (key) {
                    if (key.charAt(0) !== '.') row[key] = record[key];
                });
                definitions[module].fields.forEach(function (field) {
                    if (row[field[0]] == null) return;
                    if (field[2] === 'number') row[field[0]] = Number(row[field[0]]);
                    if (field[2] === 'bool') row[field[0]] = String(row[field[0]]) === 'true';
                });
                return row;
            });
            return toPayload(module, rows);
        }
        const pending = function () {
            try { return JSON.stringify(getPayload()) !== original; }
            catch (error) { return true; }
        };
        const updateState = function () {
            state.textContent = pending() ? _('Unsaved modifications') : _('No pending changes');
        };
        const busy = function (working) {
            loading = working; selector.disabled = working;
            container.inert = working;
            Array.from(buttons.querySelectorAll('button')).forEach(function (button) {
                button.disabled = working;
            });
        };
        function task(action) {
            if (loading) return;
            busy(true);
            return Promise.resolve().then(action).catch(function (error) {
                inform(String(error), false);
            }).finally(function () { busy(false); });
        }
        function show(data) {
            if (!data || !data.success || !data.revision)
                throw new Error(data?.error || _('Cannot read collection'));
            revision = data.revision;
            const rows = toRows(module, data.items);
            original = JSON.stringify(toPayload(module, rows));
            map = new form.JSONMap({entry: rows});
            map.data.save = function () {
                updateState();
                return Promise.resolve();
            };
            const section = map.section(form.GridSection, 'entry', definitions[module].title);
            section.anonymous = true;
            section.addremove = true;
            section.sortable = !mapped[module];
            section.cloneable = true;
            // JSONMap has no UCI clone RPC; keep LuCI's Clone button and copy locally.
            section.handleClone = function (sectionId) {
                const copy = JSON.parse(JSON.stringify(map.data.get('json', sectionId)));
                Object.keys(copy).forEach(function (key) {
                    if (key.charAt(0) === '.') delete copy[key];
                });
                const used = new Set(map.data.sections('json', 'entry').map(function (row) { return row.name; }));
                const root = copy.name + '-copy';
                copy.name = root;
                for (let suffix = 2; used.has(copy.name); suffix++) copy.name = root + '-' + suffix;
                const id = map.data.add('json', 'entry');
                Object.assign(map.data.get('json', id), copy);
                return map.save(null, true);
            };
            section.modaltitle = definitions[module].title;
            const keys = definitions[module].fields.map(function (field) { return field[0]; });
            definitions[module].fields.forEach(function (field) {
                const kind = field[2], key = field[0];
                const option = section.option(kind === 'lines' ? form.DynamicList :
                    (kind === 'enum' || kind === 'bool' ? form.ListValue : form.Value), key, field[1]);
                if (key !== 'name' && key !== 'type') option.modalonly = true;
                option.rmempty = key !== 'name' && key !== 'type';
                if (kind === 'enum' && option.rmempty) option.value('', _('Unmodified'));
                if (kind === 'enum') field[3].forEach(function (value) { option.value(value); });
                if (kind === 'bool') {
                    option.value('', _('Inherit'));
                    option.value('true', _('Enabled'));
                    option.value('false', _('Disabled'));
                }
                if (kind === 'number') option.datatype = key === 'port' ? 'port' : 'uinteger';
                if (kind === 'lines') option.datatype = 'maxlength(512)';
                option.default = definitions[module].defaults[key];
                if (key === 'name') {
                    option.datatype = 'maxlength(128)';
                    option.validate = function (sectionId, value) {
                        const name = value.trim();
                        if (!name || /[\x00-\x1f\x7f]/.test(name))
                            return _('Every entry needs a valid name');
                        return !map.data.sections('json', 'entry').some(function (row) {
                            return row['.name'] !== sectionId && String(row.name || '').trim() === name;
                        }) || _('Duplicate name: ') + name;
                    };
                }
            });
            const extra = section.option(form.TextValue, '_extra', _('Additional fields (JSON)'));
            extra.modalonly = true;
            extra.rows = 6;
            extra.default = '{}';
            extra.cfgvalue = function (sectionId) {
                const record = this.map.data.get('json', sectionId);
                const value = {};
                Object.keys(record).forEach(function (key) {
                    if (key.charAt(0) !== '.' && keys.indexOf(key) < 0) value[key] = record[key];
                });
                return JSON.stringify(value, null, 2);
            };
            extra.validate = function (sectionId, value) {
                try {
                    const data = JSON.parse(value || '{}');
                    if (!data || typeof data !== 'object' || Array.isArray(data))
                        return _('Expected JSON object');
                    if (Object.keys(data).some(function (key) {
                        return key.charAt(0) === '.' || keys.indexOf(key) >= 0 || key === '_extra';
                    })) return _('Use the form controls for known fields.');
                    return true;
                } catch (error) { return _('Expected JSON object'); }
            };
            extra.write = function (sectionId, value) {
                const record = this.map.data.get('json', sectionId);
                Object.keys(record).forEach(function (key) {
                    if (key.charAt(0) !== '.' && keys.indexOf(key) < 0) delete record[key];
                });
                Object.assign(record, JSON.parse(value || '{}'));
            };
            return map.render().then(function (node) {
                container.replaceChildren(node);
                updateState();
            });
        }
        function reload() {
            return nikki.collectionRead(module).then(show);
        }
        selector.addEventListener('change',function () {
            const selected = selector.value;
            if (pending() && !window.confirm(_('Discard unsaved collection changes?'))) {
                selector.value = module; return;
            }
            task(function () {
                return nikki.collectionRead(selected).then(function (data) {
                    if (!data.success) { selector.value = module; throw new Error(data.error); }
                    module = selected; return show(data);
                });
            });
        });
        function button(label, callback, discard) {
            if (buttons.childNodes.length) buttons.appendChild(document.createTextNode(' '));
            buttons.appendChild(E('button', {'class':'btn cbi-button','type':'button',
                'click':function () { return task(function () { return discard ? callback() : map.parse().then(callback); }); }},label));
        }
        button(_('Discard edits'),function () {
            if (pending() && !window.confirm(_('Discard local changes?'))) return;
            return reload();
        }, true);
        button(_('Save collection'),function () {
            const data=getPayload();
            if (!pending()) return inform(_('Nothing to save'),true);
            return nikki.collectionWrite(module,data,revision,false).then(function (result) {
                if (!result.success) throw new Error(result.error || _('Save failed'));
                return reload().then(function () {
                    inform(_('Collection saved; use Preview or Apply to update the running core.'),true);
                });
            });
        });
        button(_('Preview effective YAML'),function () {
            const data=getPayload();
            return nikki.collectionWrite(module,data,revision,true).then(function (draft) {
                if (!draft.success) throw new Error(draft.error || _('Invalid draft'));
                return nikki.overridePreview(module,draft.content).then(function (result) {
                    if (!result.success) throw new Error(result.error || _('Merge failed'));
                    ui.showModal(_('Merged configuration preview'), [
                        E('p',{},_('May include provider URLs, secrets and node credentials. Preview does not save or restart.')),
                        E('textarea', {'readonly':'','rows':26,'wrap':'off',
                            'style':'width:100%;min-height:420px;font-family:monospace'},result.content),
                        E('div',{'class':'right'},E('button',{'class':'btn','type':'button','click':ui.hideModal},_('Close')))
                    ],'wide');
                });
            });
        });
        button(_('Test and apply safely'),function () {
            if (!pending()) return inform(_('Nothing to apply'),true);
            if (!window.confirm(_('Test the merged profile, save the collection and restart Nikki RS? A failed restart will trigger rollback.'))) return;
            const data=getPayload();
            return nikki.collectionWrite(module,data,revision,true).then(function (draft) {
                if (!draft.success) throw new Error(draft.error || _('Invalid draft'));
                return nikki.configApply(module,draft.content,revision).then(function (result) {
                    if (!result.success) throw new Error(_('Apply failed: ') + (result.status || 'FAILED'));
                    return reload().then(function () {
                        inform(_('Collection applied and service health check passed.'),true);
                    });
                });
            });
        });
        return show(initial).then(function () { return E('div',{'class':'cbi-map'},[
            heading,
            E('p',{},_('Local groups, listeners and proxy providers are prepended or merged without modifying subscriptions. Manage routing rules and rule providers in Mixin Config.')),
            E('div', {'class':'cbi-value'}, [
                E('label', {'class':'cbi-value-title', 'for':'collection-module'}, _('Collection')),
                E('div', {'class':'cbi-value-field'}, selector)
            ]), state,container,buttons,
            E('p',{'class':'cbi-value-description'},[
                _('Use '),
                E('a',{'href':L.url('admin/services/nikki-rs/overrides')},_('Advanced Config')),
                _(' for DNS2 rules, provider templates and other advanced YAML. In eBPF mode any TUN listeners will be filtered from the effective profile.')
            ])
        ]); });
    },
    handleSave:null, handleSaveApply:null, handleReset:null
});
