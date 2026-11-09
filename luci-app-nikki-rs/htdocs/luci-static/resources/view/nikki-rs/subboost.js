'use strict';
'require view';
'require uci';
'require ui';
'require rpc';

const updateSubscription = rpc.declare({
    object: 'luci.nikki-rs',
    method: 'update_subscription',
    params: ['section_id'],
    expect: { '': {} }
});

function validHttpUrl(value) {
    if (typeof value !== 'string' || value.trim() !== value || !value)
        return false;
    try {
        const parsed = new URL(value);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
            !!parsed.hostname && !parsed.username && !parsed.password && !parsed.hash;
    } catch (e) {
        return false;
    }
}

function clashRsTargetUrl(url) {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/');
    // Only add the target parameter to SubBoost's own generated YAML API.
    // Arbitrary third-party subscriptions remain untouched.
    if (parts.length === 5 && parts[1] === 'api' && parts[2] === 'subscriptions' &&
        parts[3] && parts[4] === 'config.yaml')
        parsed.searchParams.set('target', 'clash-rs');
    return parsed.toString();
}

function notification(message, level) {
    ui.addNotification(null, E('p', {}, message), level || 'info');
}

function importSubscription(name, url, sourceId) {
    name = String(name || '').trim();
    if (!name || !validHttpUrl(url)) {
        notification(_('Enter a subscription name and a valid SubBoost YAML URL.'), 'error');
        return Promise.resolve(false);
    }

    const targetUrl = clashRsTargetUrl(url);
    const existing = uci.sections('nikki-rs', 'subscription').find(function (entry) {
        return (sourceId && entry.subboost_source === sourceId) ||
            entry.url === url || entry.url === targetUrl;
    });
    const sectionId = existing ? existing['.name'] : uci.add('nikki-rs', 'subscription');

    uci.set('nikki-rs', sectionId, 'name', name);
    uci.set('nikki-rs', sectionId, 'url', targetUrl);
    uci.set('nikki-rs', sectionId, 'user_agent', 'clash-rs');
    uci.set('nikki-rs', sectionId, 'prefer', 'remote');
    uci.set('nikki-rs', sectionId, 'subboost_managed', '1');
    if (sourceId)
        uci.set('nikki-rs', sectionId, 'subboost_source', sourceId);

    // Preserve the currently selected profile; only create or update a subscription.
    return uci.save().then(function () {
        return uci.apply();
    }).then(function () {
        return updateSubscription(sectionId);
    }).then(function (result) {
        if (!result || result.success !== true) {
            notification(_('Subscription saved, but refresh failed. Check Nikki RS logs and retry from Profile.'), 'warning');
        } else {
            notification(_('Subscription imported and refreshed. Select it under App Config to activate it.'));
        }
        return true;
    }).catch(function (error) {
        notification(_('Unable to save or refresh the SubBoost subscription: ') +
            (error.message || String(error)), 'error');
        return false;
    });
}

return view.extend({
    load: function () {
        return uci.load('nikki-rs').then(function () {
            return L.resolveDefault(uci.load('subboost'), null);
        });
    },

    render: function () {
        const saved = uci.sections('subboost', 'subscription').filter(function (section) {
            return !!section.name && validHttpUrl(section.url);
        });
        const managed = uci.sections('nikki-rs', 'subscription').filter(function (section) {
            return section.subboost_managed === '1' || !!section.subboost_source;
        });

        const nameInput = E('input', {
            'class': 'cbi-input-text',
            'type': 'text',
            'placeholder': _('e.g. My SubBoost subscription'),
            'autocomplete': 'off'
        });
        const urlInput = E('input', {
            'class': 'cbi-input-text',
            'type': 'url',
            'placeholder': 'https://your-subboost.example/api/subscriptions/TOKEN/config.yaml',
            'autocomplete': 'off',
            'spellcheck': 'false'
        });

        const importButton = E('button', {
            'type': 'button',
            'class': 'btn cbi-button-positive',
            'click': function (event) {
                event.preventDefault();
                importButton.disabled = true;
                return importSubscription(nameInput.value, urlInput.value, null).then(function (ok) {
                    if (ok) window.location.reload();
                }).finally(function () {
                    importButton.disabled = false;
                });
            }
        }, _('Import and refresh'));

        const children = [
            E('h2', {}, _('SubBoost integration')),
            E('p', {}, [
                _('Import a generated SubBoost Clash/Mihomo YAML subscription. Nikki RS uses its native download, YAML validation and update mechanism. This does not switch your active profile. '),
                E('a', {
                    'href': 'https://subboost.org',
                    'target': '_blank',
                    'rel': 'noopener noreferrer'
                }, _('Open SubBoost editor'))
            ]),
            E('div', {'class': 'cbi-section'}, [
                E('h3', {}, _('Import generated subscription URL')),
                E('div', {'class': 'cbi-value'}, [
                    E('label', {'class': 'cbi-value-title'}, _('Name')),
                    E('div', {'class': 'cbi-value-field'}, nameInput)
                ]),
                E('div', {'class': 'cbi-value'}, [
                    E('label', {'class': 'cbi-value-title'}, _('Generated YAML URL')),
                    E('div', {'class': 'cbi-value-field'}, urlInput)
                ]),
                E('div', {'class': 'cbi-page-actions'}, importButton)
            ])
        ];

        if (saved.length) {
            const select = E('select', { 'class': 'cbi-input-select' },
                saved.map(function (entry) {
                    return E('option', {'value': entry['.name']}, entry.name);
                })
            );
            const savedButton = E('button', {
                'type': 'button',
                'class': 'btn cbi-button-action',
                'click': function (event) {
                    event.preventDefault();
                    const selected = saved.find(function (entry) {
                        return entry['.name'] === select.value;
                    });
                    if (!selected) return Promise.resolve();
                    savedButton.disabled = true;
                    return importSubscription(selected.name, selected.url, selected['.name']).then(function (ok) {
                        if (ok) window.location.reload();
                    }).finally(function () {
                        savedButton.disabled = false;
                    });
                }
            }, _('Sync selected subscription'));

            children.push(E('div', {'class': 'cbi-section'}, [
                E('h3', {}, _('Subscriptions saved in LuCI SubBoost')),
                E('p', {}, _('Import from Services > SubBoost without copying URLs again.')),
                select, ' ', savedButton
            ]));
        }

        if (managed.length) {
            children.push(E('div', {'class': 'cbi-section'}, [
                E('h3', {}, _('Previously imported subscriptions')),
                E('ul', {}, managed.map(function (entry) {
                    return E('li', {}, entry.name || entry['.name']);
                }))
            ]));
        }

        children.push(E('p', { 'class': 'cbi-map-descr' },
            _('SubBoost generated links automatically use the clash-rs target (including namespaced rule caches and Geo database paths). Links contain a secret token and are saved in UCI. HTTPS is recommended.')));

        return E('div', { 'class': 'cbi-map' }, children);
    }
});
