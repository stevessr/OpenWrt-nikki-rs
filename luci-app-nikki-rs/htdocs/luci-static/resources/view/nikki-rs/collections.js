'use strict';
'require view';
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
    'rule-providers': {
        title: _('Rule Providers'),
        fields: [
            ['name', _('Provider ID'), 'text'],
            ['type', _('Source type'), 'enum', ['http','file']],
            ['behavior', _('Rule format behavior'), 'enum', ['domain','ipcidr','classical']],
            ['format', _('File format'), 'enum', ['yaml','text','mrs']],
            ['url', _('Download URL'), 'text'],
            ['path', _('Cache/file path'), 'text'],
            ['interval', _('Refresh interval (seconds)'), 'number']
        ],
        defaults: {name:'my-rules',type:'file',behavior:'classical',path:'./providers/rule/my-rules.yaml'}
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
function parseInput(field, control) {
    const kind = field[2];
    if (kind === 'lines') {
        const lines = control.value.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
        if (lines.length > 128 || lines.some(function (s) { return s.length > 512; }))
            throw new Error(_('List too long'));
        return lines;
    }
    if (kind === 'number') {
        const raw = control.value.trim();
        if (!raw) return undefined;
        if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
            throw new Error(_('Invalid integer'));
        return Number(raw);
    }
    if (kind === 'bool') {
        return control.value === '' ? undefined : control.value === 'true';
    }
    if (!control.value.trim()) return undefined;
    return control.value.trim();
}
function controlFor(field, value, onUpdate) {
    const kind = field[2];
    let input;
    if (kind === 'enum' || kind === 'bool') {
        const options = kind === 'bool' ? ['', 'true', 'false'] : field[3];
        input = E('select', { 'class':'cbi-input-select', 'style':'max-width:100%;min-width:190px' },
            options.map(function (option) {
                return E('option', {value:option},
                    kind === 'bool' && option === '' ? _('Inherit') : option);
            }));
        const actual = value == null ? '' : String(value);
        if (options.indexOf(actual) < 0 && actual !== '')
            input.appendChild(E('option', {value:actual}, actual));
        input.value = actual;
    } else if (kind === 'lines') {
        input = E('textarea', {
            'class':'cbi-input-textarea','rows':3,
            'style':'width:100%;min-width:210px;resize:vertical',
            'placeholder':_('One name per line')
        }, Array.isArray(value) ? value.join('\n') : '');
    } else {
        input = E('input', {
            'class':'cbi-input-text','type':kind === 'number' ? 'number':'text',
            'style':'width:100%;min-width:210px',
            'value':value == null ? '' : String(value)
        });
        if (kind === 'number') input.min = '0';
    }
    input.addEventListener('change', onUpdate);
    input.addEventListener('input', onUpdate);
    return input;
}
return view.extend({
    load:function () { return nikki.collectionRead('proxy-groups'); },
    render:function (initial) {
        let module = 'proxy-groups';
        let revision = '';
        let rows = [];
        let original = '[]';
        let loading = false;
        const selector = E('select', { 'class':'cbi-input-select' },
            moduleNames.map(function (name) {
                return E('option', {value:name}, definitions[name].title);
            }));
        const heading = E('h2', {}, _('Clash Collections Builder'));
        const state = E('p', {'class':'cbi-value-description'});
        const container = E('div');
        const buttons = E('div', {'style':'display:flex;flex-wrap:wrap;gap:.6em;margin:.8em 0'});
        const pending = function () {
            try { return JSON.stringify(toPayload(module, rows)) !== original; }
            catch (error) { return true; }
        };
        const updateState = function () {
            state.textContent = _('Local entries: ') + rows.length + ' · ' +
                (pending() ? _('Unsaved modifications') : _('No pending changes'));
        };
        const busy = function (working) {
            loading = working; selector.disabled = working;
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
        function getPayload() { return toPayload(module, rows); }
        function redraw() {
            container.replaceChildren();
            rows.forEach(function (entry, index) {
                const fields = definitions[module].fields;
                const card = E('div', { 'class':'cbi-section',
                    'style':'border:1px solid var(--border-color-low,#ddd);padding:.8em;margin:.8em 0' });
                const controls = E('div', {
                    'style':'display:flex;gap:.4em;flex-wrap:wrap;margin:.4em 0'
                });
                function action(label, fn) {
                    return E('button', { 'type':'button', 'class':'btn cbi-button',
                        'click':function () {
                            if (loading) return;
                            try { fn(); } catch (error) { inform(String(error), false); }
                        } }, label);
                }
                card.appendChild(E('h4', {}, (index + 1) + '. ' + (entry.name || _('Unnamed'))));
                controls.appendChild(action('↑', function () {
                    if (index < 1) return;
                    const swap = rows[index-1]; rows[index-1] = rows[index]; rows[index] = swap; redraw();
                }));
                controls.appendChild(action('↓', function () {
                    if (index >= rows.length - 1) return;
                    const swap = rows[index+1]; rows[index+1] = rows[index]; rows[index] = swap; redraw();
                }));
                controls.appendChild(action(_('Copy'), function () {
                    const copy = JSON.parse(JSON.stringify(entry));
                    copy.name = copy.name + '-copy';
                    rows.splice(index+1,0,copy); redraw();
                }));
                controls.appendChild(action(_('Delete'), function () {
                    rows.splice(index,1); redraw();
                }));
                controls.appendChild(action(_('Advanced JSON'), function () {
                    const editor = E('textarea', {
                        'class':'cbi-input-textarea','rows':20,
                        'style':'width:100%;min-height:320px;font-family:monospace'
                    }, JSON.stringify(entry,null,2));
                    ui.showModal(_('Advanced collection entry'), [
                        E('p',{},_('Any extra clash-rs fields can be edited here. Unknown fields are retained by normal form edits.')),
                        editor,
                        E('div',{'class':'right'}, [
                            E('button',{'class':'btn','type':'button','click':ui.hideModal},_('Cancel')),
                            E('button',{'class':'btn cbi-button-positive','type':'button',
                                'click':function () {
                                    try {
                                        const value = JSON.parse(editor.value);
                                        if (!value || typeof value !== 'object' || Array.isArray(value))
                                            throw new Error(_('Expected JSON object'));
                                        rows[index] = value; ui.hideModal(); redraw();
                                    } catch (error) { inform(String(error), false); }
                                }},_('Use JSON'))
                        ])
                    ],'wide');
                }));
                card.appendChild(controls);
                fields.forEach(function (field) {
                    const key = field[0];
                    let input;
                    const refresh = function () {
                        try {
                            const value = parseInput(field, input);
                            if (value === undefined) delete entry[key];
                            else entry[key] = value;
                            updateState();
                        } catch (error) {
                            state.textContent = String(error);
                        }
                    };
                    input = controlFor(field, entry[key], refresh);
                    card.appendChild(E('div', {
                        'style':'display:grid;grid-template-columns:minmax(170px,1fr) minmax(220px,2fr);gap:.6em;align-items:start;padding:.3em 0'
                    }, [
                        E('label',{'style':'font-weight:600'},field[1]),
                        input
                    ]));
                });
                container.appendChild(card);
            });
            updateState();
        }
        function show(data) {
            if (!data || !data.success || !data.revision)
                throw new Error(data?.error || _('Cannot read collection'));
            revision = data.revision;
            rows = toRows(module,data.items);
            original = JSON.stringify(toPayload(module,rows));
            redraw();
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
                    module = selected; show(data);
                });
            });
        });
        function button(label, callback) {
            buttons.appendChild(E('button', {'class':'btn cbi-button','type':'button',
                'click':function () { return task(callback); }},label));
        }
        button(_('Add entry'),function () {
            const candidate=JSON.parse(JSON.stringify(definitions[module].defaults));
            const used=new Set(rows.map(function (entry) {return entry.name;}));
            let suffix=2, root=candidate.name;
            while (used.has(candidate.name)) candidate.name=root+'-'+suffix++;
            rows.push(candidate); redraw();
        });
        button(_('Discard edits'),function () {
            if (pending() && !window.confirm(_('Discard local changes?'))) return;
            return reload();
        });
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
        try { show(initial); } catch (error) { inform(String(error),false); }
        return E('div',{'class':'cbi-map'},[
            heading,
            E('p',{},_('Manage locally owned groups, listeners and generic providers. Imported subscription arrays are preserved. To edit every clash-rs-specific option, use Advanced JSON for an entry or Advanced Config for the whole module.')),
            selector,state,buttons,container,
            E('p',{'class':'cbi-value-description'},[
                _('Use '),
                E('a',{'href':L.url('admin/services/nikki-rs/overrides')},_('Advanced Config')),
                _(' for DNS2 rules, provider templates and other advanced YAML. In eBPF mode any TUN listeners will be filtered from the effective profile.')
            ])
        ]);
    },
    handleSave:null, handleSaveApply:null, handleReset:null
});
