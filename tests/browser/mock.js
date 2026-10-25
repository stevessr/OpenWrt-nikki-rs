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
    version: () => reply({app:'test',core:'test'}),
    status: () => reply(true),
    listProfiles: () => reply([]),
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
        return reply({success:true,content:'mode: rule\n'});
    },
    configApply: (module,content,revision) => {
        calls.push({op:'configApply',module,content,revision});
        return reply({success:true});
    },
    validateConfig: () => reply({success:true}),
    saveConfigRevision: (path,content,revision) => {
        calls.push({op:'saveConfigRevision',path,content,revision});
        return reply({success:true});
    },
    listConfigBackups: () => reply({backups:['revision-1.yaml']}),
    restoreConfig: () => reply({success:true}),
    overrideTest: () => reply({success:true}),
    overrideInspect: () => reply({success:true,info:'{"mode":"rule","rules":1,"proxies":0,"groups":0,"duplicate_rules":0}'}),
    overrideAnalyze: () => reply({success:true,report:{changed_sections:[],before:{},after:{dns:true}}})
};
