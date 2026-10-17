import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildIndex} from './java-index.ts';
import {extractApis,identify,type ApiEntry} from './spring.ts';
import {mergeDelta} from './enrich.ts';
async function fixture(source:string){
 const root=await mkdtemp(path.join(os.tmpdir(),'authz-spring-'));
 await mkdir(path.join(root,'src/main/java/p'),{recursive:true});
 await writeFile(path.join(root,'src/main/java/p/C.java'),source);
 const index=await buildIndex(root,[],new AbortController().signal);
 assert.deepEqual(index.diagnostics,[]);
 return {root,index,entries:extractApis(index,'revision')};
}
const names=(e:ApiEntry)=>e.api.request_fields.map(f=>f.location+':'+f.name+':'+f.type);
test('routes use syntax structure, arrays, constants and stable identities; no implicit GET',async()=>{
 const {entries}=await fixture(`package p; @RestController @RequestMapping({"/a","/b"}) class C { static final String END="/end"; @RequestMapping(value=END,method={RequestMethod.POST,RequestMethod.PUT}) public void x(@RequestParam("id") Long id){} @RequestMapping("/any") public void y(){} }`);
 assert.equal(entries.length,6);assert.equal(entries.filter(e=>e.api.method==='ANY').length,2);
 assert.deepEqual(entries.map(e=>e.api.api_id),[...entries].map(e=>identify(e.detail.identity)));
 assert.deepEqual(names(entries.find(e=>e.api.path==='/a/end'&&e.api.method==='POST')!),['form:id:integer','query:id:integer']);
});
test('DTO inheritance, JSON rename, nested arrays and readonly exclusion',async()=>{
 const {entries}=await fixture(`package p; @Data class Base { private Long id; } @Data class Item {private String name;} @Data class Dto extends Base { @JsonProperty("owner") private String user; private List<Item> items; @JsonProperty(access=JsonProperty.Access.READ_ONLY) private String server; @JsonIgnore private String hidden; } @RestController class C {@PostMapping("/dto") public void run(@RequestBody Dto dto,@RequestHeader("X-Token") String token){}}`);
 assert.deepEqual(names(entries[0]),['body:id:integer','body:items[].name:string','body:owner:string','header:X-Token:string']);
 assert.deepEqual(entries[0].api.unresolved,[]);
});
test('dynamic bodies follow aliases and two call layers, including CSV encoding',async()=>{
 const {entries}=await fixture(`package p; interface Service {void accept(JSONObject p);} class Impl implements Service { public void accept(JSONObject p){String ids=p.getString("ids"); helper(ids); } void helper(String ids){ids.split(",");}} @RestController class C {private Service service; @PostMapping("/dynamic") public void run(@RequestBody JSONObject body){JSONObject alias=body; service.accept(alias);}}`);
 assert.deepEqual(names(entries[0]),['body:ids:string']);
 assert.match(entries[0].api.request_fields[0].note||'',/逗号/);
 assert.deepEqual(entries[0].api.unresolved,[]);
});
test('servlet bindings and query/form alternatives do not include server-only variables',async()=>{
 const {entries}=await fixture(`package p; @RestController class C {@PostMapping("/read") public void run(HttpServletRequest req){String id=req.getParameter("id"); String h=req.getHeader("X-Tenant"); Map out=new HashMap(); out.get("serverOnly"); LoginUser principal=auth.current();}}`);
 assert.deepEqual(names(entries[0]),['form:id:string','header:X-Tenant:string','query:id:string']);
});
test('interface mappings and body generics are resolved without merging controllers',async()=>{
 const {entries}=await fixture(`package p; interface Routes {@GetMapping("/x") String x(@RequestParam("q") String q);} @RestController @RequestMapping("/c") class C implements Routes {public String x(String q){return q;}} @Data class Item {private Long id;} @Data class Box<T> {private T payload;} @RestController class D {@PostMapping("/generic") public void run(@RequestBody Box<Item> body){}}`);
 assert.equal(entries.length,2);assert.deepEqual(names(entries.find(e=>e.api.path==='/c/x')!),['query:q:string']);
 assert.deepEqual(names(entries.find(e=>e.api.path==='/generic')!),['body:payload.id:integer']);
});
test('dynamic keys, unresolved calls and parse failures remain visible',async()=>{
 const {root,index,entries}=await fixture(`package p; @RestController class C {@PostMapping("/x") public void run(@RequestBody JSONObject p){String k=remote();p.getString(k);outside.accept(p);}}`);
 assert.equal(entries[0].api.request_fields.length,0);assert.ok(entries[0].api.unresolved.some(x=>x.includes('动态字段')));
 await writeFile(path.join(root,'src/main/java/p/Broken.java'),'class { invalid');
 const broken=await buildIndex(root,[],new AbortController().signal);
 assert.equal(broken.files.length,2);assert.equal(broken.files.filter(f=>f.status==='failed').length,1);assert.equal(broken.diagnostics.length,1);
});
test('model deltas need observed evidence; routes and known types are authoritative',async()=>{
 const {index,entries}=await fixture(`package p; @RestController class C {@PostMapping("/x") public void run(@RequestBody JSONObject p){String ids=p.getString("ids");ids.split(",");}}`);
 const entry=entries[0],e={file:entry.api.file,start_line:1,end_line:1};
 const valid=mergeDelta(entry,{fields:[{name:'ids',location:'body',type:'string',note:'列表编码',evidence:[e]}],resolved:[],unresolved:[]},[e],index);
 assert.equal(valid.detail.enrichment_accepted,1);
 const bad=mergeDelta(entry,{fields:[{name:'ids',location:'body',type:'integer',evidence:[e]}],resolved:[],unresolved:[]},[e],index);
 assert.equal(bad.detail.enrichment_accepted,0);assert.equal(bad.api.request_fields[0].type,'string');
 const unobserved=mergeDelta(entry,{fields:[{name:'ids',location:'body',type:'string',evidence:[e]}],resolved:[],unresolved:[]},[],index);
 assert.equal(unobserved.detail.enrichment_accepted,0);
});

test('implicit interface constants, cast servlet aliases, multipart file and literal array key',async()=>{
 const {entries}=await fixture(`package p; interface Keys {String TOKEN="X-Token";} @RestController class C {@PostMapping("/upload") public void upload(HttpServletRequest request){MultipartHttpServletRequest multipart=(MultipartHttpServletRequest)request; MultipartFile f=multipart.getFile("file");request.getHeader(Keys.TOKEN);} @GetMapping("/array") public void array(@RequestParam("ids[]") List<Integer> ids){}}`);
 assert.deepEqual(names(entries.find(e=>e.api.path==='/upload')!),['form:file:file','header:X-Token:string']);
 assert.deepEqual(names(entries.find(e=>e.api.path==='/array')!),['query:ids[]:integer']);
});
test('class and method HTTP conditions follow Spring union semantics',async()=>{
 const {entries}=await fixture(`package p; @RestController @RequestMapping(value="/c",method=RequestMethod.GET) class C {@RequestMapping(value="/m",method=RequestMethod.POST) public void run(){}}`);
 assert.deepEqual(entries.map(e=>e.api.method),['GET','POST']);
});

test('explicit trailing slashes are preserved as declared routes',async()=>{
 const {entries}=await fixture(`package p; @RestController @RequestMapping("/api") class C {@GetMapping({"/x","/x/"}) public void run(){}}`);
 assert.deepEqual(entries.map(e=>e.api.path),['/api/x','/api/x/']);
});

test('a model type refinement does not erase dynamic-key uncertainty',async()=>{
 const {index,entries}=await fixture(`package p; @Data class Dto { private Map<String,Object> options; } @RestController class C {@PostMapping("/x") public void run(@RequestBody Dto p){}}`);
 const entry=entries[0],e={file:entry.api.file,start_line:1,end_line:1};
 const out=mergeDelta(entry,{fields:[{name:'options',location:'body',type:'object',evidence:[e]}],resolved:[...entry.api.unresolved],unresolved:[]},[e],index);
 assert.equal(out.detail.enrichment_accepted,1);assert.equal(out.api.request_fields[0].type,'object');assert.deepEqual(out.api.unresolved,entry.api.unresolved);
});

test('Comparable is a standard behaviour interface, not a missing DTO property parent',async()=>{
 const {entries}=await fixture('package p; @RestController class C { @GetMapping("/x") void run(Item q){} } @Data class Item implements Comparable<Item>{private String id; public int compareTo(Item x){return 0;} }');
 const api=entries[0];assert.ok(!api.api.unresolved.some(u=>u.includes('Comparable')));assert.deepEqual(api.api.request_fields.map(f=>f.name),['id']);
});

test('deep helper inputs and nested model proposals remain explicitly bounded rather than invented',async()=>{
 const {index,entries}=await fixture('package p; @RestController class C{@PostMapping("/x")void run(@RequestBody JSONObject p){a(p);}void a(JSONObject p){b(p);}void b(JSONObject p){c(p);}void c(JSONObject p){p.getString("deep");}}');
 const e=entries[0],proof={file:e.api.file,start_line:1,end_line:1};assert.ok(e.api.unresolved.some(x=>x.includes('超过两层')));
 const r=mergeDelta(e,{fields:[{name:'deep',location:'body',type:'string',evidence:[proof]},{name:'profile.id',location:'body',type:'string',evidence:[proof]}],resolved:[...e.api.unresolved],unresolved:[]},[proof],index);
 assert.equal(r.detail.enrichment_accepted,0);assert.ok(r.api.unresolved.some(x=>x.includes('超过两层')));assert.equal(r.api.request_fields.length,0);
});
