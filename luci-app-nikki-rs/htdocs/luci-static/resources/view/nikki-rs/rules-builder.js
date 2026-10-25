'use strict';
'require view';

/* Keep old bookmarks working without maintaining a second rules editor.
 * Existing nikki-rules remain editable in their original YAML module. */
return view.extend({
    render: function () {
        const url = L.url('admin/services/nikki-rs/overrides') + '?module=rules';
        window.location.replace(url);
        return E('p', {}, E('a', { 'href': url }, _('Advanced Config')));
    },
    handleSave: null,
    handleSaveApply: null,
    handleReset: null
});
