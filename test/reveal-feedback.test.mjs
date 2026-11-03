import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Readable} from 'node:stream';
import {createRevealHandler,REVEAL_PATH} from '../src/reveal.js';
const token='a'.repeat(64),origin='http://127.0.0.1:5000';
const name='generated-'+ 'a'.repeat(32)+'.png';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
async function invoke(t,native){
 const root=await mkdtemp(join(tmpdir(),'dsh-folder-feedback-'));assert.ok(resolve(root).startsWith(resolve(tmpdir())));t.after(()=>rm(root,{recursive:true,force:true}));
 const cache=join(root,'cache'),output=join(root,'output');await mkdir(cache);await mkdir(output);await writeFile(join(cache,name),png);await writeFile(join(output,name),png);
 const handler=createRevealHandler({cacheDir:cache,maxImageBytes:1024},{token,origin:()=>origin,revealFile:async(file)=>{assert.equal(file,join(output,name));return native();}});
 const req=Readable.from([Buffer.from(JSON.stringify({filename:name,path:join(output,name)}))]);req.method='POST';req.url=REVEAL_PATH;req.socket={remoteAddress:'127.0.0.1'};req.headers={origin,'content-type':'application/json','x-dsh-gpt-images-token':token};
 const result={};const res={writeHead(status){result.status=status;},end(body){result.body=JSON.parse(body);}};await handler(req,res);return result;
}
test('HTTP仅在native确认可见选中且前台时报告完整成功',async(t)=>{const r=await invoke(t,()=>({requested:true,selected:true,foreground:true}));assert.equal(r.status,200);assert.equal(r.body.selected,true);assert.equal(r.body.foreground,true);assert.match(r.body.message,/已打开文件夹并选中/);});
test('HTTP保留已选中但OS拒绝切前台的后台状态',async(t)=>{const r=await invoke(t,()=>({requested:true,selected:true,foreground:false}));assert.equal(r.status,200);assert.equal(r.body.selected,true);assert.equal(r.body.foreground,false);assert.match(r.body.message,/后台|任务栏/);assert.doesNotMatch(r.body.message,/已打开文件夹并选中/);});
test('旧式void或仅spawn的native结果不能被提升为已选中/前台',async(t)=>{for(const native of [undefined,{requested:true,selected:false,foreground:false}]){const r=await invoke(t,()=>native);assert.equal(r.body.selected,false);assert.equal(r.body.foreground,false);assert.match(r.body.message,/尚未确认/);assert.doesNotMatch(r.body.message,/已打开文件夹并选中/);}});
test('native未确认实际窗口时HTTP明确失败且不泄露异常路径',async(t)=>{const r=await invoke(t,()=>{throw new Error('C:/private/secret');});assert.equal(r.status,500);assert.equal(r.body.ok,false);assert.match(r.body.message,/未确认/);assert.doesNotMatch(r.body.message,/private|secret/);});
