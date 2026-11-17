window.calls = [];
window.failNext = false;
const schema = [
    {id:'routing-mark',path:'routing-mark',label:'Routing mark',kind:'int',min:0,max:4294967295},
    {id:'bind-address',path:'bind-address',label:'Bind address',kind:'string'},
    {id:'profile.store-selected',path:'profile.store-selected',label:'Store selected',kind:'bool'},
    {id:'profile.store-fake-ip',path:'profile.store-fake-ip',label:'Store fake IP',kind:'bool'},
    {id:'profile.store-smart-stats',path:'profile.store-smart-stats',label:'Store smart stats',kind:'bool'},
    {id:'experimental.tcp-buffer-size',path:'experimental.tcp-buffer-size',label:'TCP buffer size',kind:'int'},
    {id:'mode',path:'mode',label:'Duplicate mode',kind:'enum',choices:['rule','global']}
];
let settings = {};
let collections = {
    'proxy-groups': [
        {name:'Local',type:'select',proxies:['DIRECT'], icon:'https://example.org/icon', custom:{retained:true}},
        {name:'Second',type:'select',proxies:['REJECT']}
    ],
    listeners: [{name:'local-http',type:'http',listen:'127.0.0.1',port:8080}],
    'proxy-providers': {provider:{type:'file',path:'./local.yaml','health-check':{enable:true}}}
};
const clone = value => JSON.parse(JSON.stringify(value));
const reply = value => new Promise(resolve => setTimeout(() => resolve(clone(value)), 20));
window.mock = {
    homeDir: '/etc/nikki-rs',
    profilesDir: '/etc/nikki-rs/profiles',
    subscriptionsDir: '/etc/nikki-rs/subscriptions',
    mixinFilePath: '/etc/nikki-rs/mixin.yaml',
    runProfilePath: '/etc/nikki-rs/run/config.yaml',
    blackFilterPath: '/etc/nikki-rs/dns/black_filter',
    fakeIpFilterPath: '/etc/nikki-rs/dns/fake_ip_filter',
    fallbackFilterPath: '/etc/nikki-rs/dns/fallback_filter',
    proxyWhitelistPath: '/etc/nikki-rs/nftables/proxy_whitelist.txt',
    proxyWhitelist6Path: '/etc/nikki-rs/nftables/proxy_whitelist6.txt',
    version: () => reply({app:'test',core:'test'}),
    status: () => reply(true),
    profile: () => reply({'proxy-groups': [{name:'Manual group',type:'select',proxies:['a','b']}], proxies:[]}),
    listProfiles: () => reply([{name:'test.yaml',type:'file',size:1024,mtime:1794950000}]),
    listProfileEntries: () => reply([{name:'test.yaml',type:'file',size:1024},{name:'ruleset',type:'directory',size:8192}]),
    startSubscriptionUpdate: section => { calls.push({op:'updateSubscription',section}); return reply({success:true}); },
    subscriptionUpdateStatus: () => reply({state:'failed',error:'HTTP 403: access denied'}),
    coreStatus: () => reply({info:window.coreFinished ? 'origin=package\nstate=failed' : 'origin=package\nstate=idle',running:false,log:window.coreFinished ? 'ERROR: Core download failed' : ''}),
    coreUpdate: () => {window.coreFinished=true; calls.push({op:'coreUpdate'}); return reply({success:true});},
    coreRollback: () => reply({success:false,error:'No override installed'}),
    updateSubscription: section => {
        calls.push({op:'updateSubscription',section});
        return reply({success:false,error:'HTTP 403: access denied'});
    },
    settingsRead: () => reply({success:true,revision:'settings-v1',fields:schema,values:settings}),
    settingsPatch: (module,delta,revision) => {
        calls.push({op:'settingsPatch',module,delta,revision});
        if (window.failNext) {window.failNext=false; return reply({success:false,error:'Conflict'});}
        Object.assign(settings,delta);
        return reply({success:true});
    },
    settingsDraft: (module,delta,revision) => {
        calls.push({op:'settingsDraft',module,delta,revision});
        return reply({success:true,content:'draft'});
    },
    collectionRead: module => reply({success:true,revision:'collection-v1',items:collections[module]}),
    collectionWrite: (module,data,revision,draft) => {
        calls.push({op:'collectionWrite',module,data:clone(data),revision,draft});
        if (!draft) collections[module]=clone(data);
        return reply({success:true,content:'draft'});
    },
    configSnapshot: path => {
        calls.push({op:'configSnapshot',path});
        return reply({success:true,revision:'yaml-v1',content:path.includes('rules.yaml')?'nikki-rules: ["MATCH,DIRECT"]\n':'{}\n'});
    },
    overridePreview: (module,content) => {
        calls.push({op:'overridePreview',module,content});
        return reply({success:true,content:'mode: rule\n',rules:{rules:['DOMAIN-SUFFIX,example.com,PROXY','MATCH,DIRECT'],rule_providers:['ads']}});
    },
    configApply: (module,content,revision) => {
        calls.push({op:'configApply',module,content,revision});
        return reply({success:true});
    },
    validateConfig: () => reply({success:true}),
    editorDiff: (path,content) => {
        calls.push({op:'editorDiff',path,content});
        return reply({success:true,
            before:'dns:\n  nameserver:\n    - 223.5.5.5\n',
            after:'dns:\n  nameserver:\n    - 127.0.0.1\n',
            mode:'yaml',note:'test comparison',
            rules_before:{rules:['DOMAIN-SUFFIX,example.com,PROXY','MATCH,DIRECT'],rule_providers:['ads']},
            rules_after:{rules:['DOMAIN-SUFFIX,new.example,REJECT','DOMAIN-SUFFIX,example.com,PROXY','MATCH,DIRECT'],rule_providers:['ads','block']}});
    },
    saveConfigRevision: (path,content,revision) => {
        calls.push({op:'saveConfigRevision',path,content,revision});
        return reply({success:true});
    },
    listConfigBackups: () => reply({backups:['revision-1.yaml']}),
    restoreConfig: () => reply({success:true}),
    overrideTest: () => reply({success:true}),
    overrideInspect: () => reply({success:true,info:'{"mode":"rule","rules":1,"proxies":0,"groups":0,"duplicate_rules":0}'}),
    overrideAnalyze: () => reply({success:true,report:{changed_sections:[],before:{},after:{dns:true}}}),
    profileEffectiveDiff: () => {
        calls.push({op:'profileEffectiveDiff'});
        return reply({success:true,mode:'yaml',note:'test profile comparison',
            before:'mode: rule\nrules:\n  - DOMAIN-SUFFIX,example.com,PROXY\n',
            after:'mode: rule\nrules:\n  - DOMAIN-SUFFIX,example.com,PROXY\n  - MATCH,DIRECT\n',
            rules_before:{rules:['DOMAIN-SUFFIX,example.com,PROXY'],rule_providers:[]},
            rules_after:{rules:['DOMAIN-SUFFIX,example.com,PROXY','MATCH,DIRECT'],rule_providers:[]}});
    },
    profileRuleImport: () => {
        calls.push({op:'profileRuleImport'});
        sessionStorage.setItem('profileRuleImportCalled', '1');
        return reply({success:true,total_rules:4,truncated:false,
            rules:['DOMAIN-SUFFIX,example.com,PROXY','MATCH,DIRECT','DOMAIN-SUFFIX,example.com,PROXY','bogus']});
    }
};
