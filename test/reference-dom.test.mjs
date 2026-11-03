import test from 'node:test';
import assert from 'node:assert/strict';
import { galleryScript } from '../src/presentation.js';
const { JSDOM } = await import(process.env.DSH_TEST_JSDOM || 'jsdom');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
const nativeOptions = {referenceToken:'a'.repeat(64),referenceEndpoint:'http://localhost/dsh-gpt-images/reference',localReferenceEndpoint:'http://localhost/dsh-gpt-images/reference'};
const fileName = (id) => 'generated-' + id.repeat(32) + '.png';
function image(id, index=1) { return '<p><img src="http://localhost/dsh-gpt-images/'+fileName(id)+'" alt="生成的图片 '+index+'"></p>'; }
const card = (id) => '<div data-composer-card id="'+id+'"><div role="group"><img alt="existing.png" src="blob:existing"></div><textarea data-phase="editing">已有修改要求，不要覆盖</textarea><button type="submit">发送</button></div>';
function setup({html,listen=true,reject=false}={}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body>'+ (html || '<section data-conversation-scroll id="a"><div id="message">'+image('a')+image('b',2)+'</div>'+card('input-a')+'</section><section data-conversation-scroll id="b">'+card('input-b')+'</section>') +'</body></html>',{url:'http://localhost/#/session-a',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window, d=w.document;
  w.matchMedia=()=>({matches:true});
  w.ResizeObserver=class {observe(){}disconnect(){}};
  w.HTMLElement.prototype.scrollIntoView=function(){};
  w.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[{}];};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
  w.DataTransfer=class {constructor(){this.items=[];this.items.add=(file)=>this.items.push({kind:'file',type:file.type,getAsFile:()=>file});}getData(){return '';}get files(){return this.items.map(i=>i.getAsFile());}};
  w.ClipboardEvent=class extends w.Event {constructor(type,options){super(type,options);this.clipboardData=options.clipboardData;}};
  const received=[]; let submits=0;
  for (const input of d.querySelectorAll('[data-composer-card] textarea, [data-composer-card] [data-composer-input][role="textbox"]')) {
    input.closest('[data-composer-card]').querySelector('button').addEventListener('click',()=>submits++);
    if(listen) input.addEventListener('paste',(event)=>{
      // Same public intake shape as DSH InputBar.onPaste: files only, no text.
      const files=[...event.clipboardData.items].filter(i=>i.kind==='file').map(i=>i.getAsFile());
      if(files.length)event.preventDefault();
      if(reject)return;
      for(const file of files){received.push({file,input});const img=d.createElement('img');img.alt=file.name;img.src='blob:host-preview';input.closest('[data-composer-card]').querySelector('[role="group"]').append(img);}
    });
  }
  w.eval(galleryScript(nativeOptions));
  const settle=()=>new Promise(r=>w.requestAnimationFrame(()=>w.requestAnimationFrame(r)));
  return {w,d,received,submits:()=>submits,settle,dispose(){w.__dshGptImagesGallery?.dispose();w.close();}};
}
const flush=()=>new Promise(r=>setImmediate(r));
const response=(changes={})=>({ok:true,headers:{get:(key)=>key==='content-type'?'image/png':key==='content-length'?String(PNG.length):null},arrayBuffer:async()=>Uint8Array.from(PNG).buffer,...changes});
const ref=(t,index=0)=>t.d.querySelectorAll('.dgi-card button[aria-label="引用"]')[index];
async function bytes(w,file){return new Promise((resolve,reject)=>{const reader=new w.FileReader();reader.onload=()=>resolve(Array.from(new Uint8Array(reader.result)));reader.onerror=reject;reader.readAsArrayBuffer(file);});}

test('引用注入真实File到同会话附件，不覆盖草稿、不发送，重复引用不重复添加',async()=>{
 const t=setup();try{
  const calls=[];t.w.fetch=async(url,options)=>{calls.push({url,options});return response();};await t.settle();
  const input=t.d.querySelector('#input-a textarea');const original=input.value;ref(t).click();await flush();await t.settle();
  assert.equal(t.received.length,1);assert.equal(t.received[0].input,input);assert.equal(t.received[0].file instanceof t.w.File,true);
  assert.equal(t.received[0].file.type,'image/png');assert.equal(t.received[0].file.name,'引用-'+fileName('a'));
  assert.deepEqual(await bytes(t.w,t.received[0].file),Array.from(PNG));
  assert.equal(input.value,original);assert.equal(t.d.querySelectorAll('#input-a [role="group"] img').length,2);
  assert.equal(t.d.querySelectorAll('#input-b [role="group"] img').length,1);assert.equal(t.submits(),0);
  assert.equal(t.d.activeElement,input);assert.deepEqual(JSON.parse(calls[0].options.body),{filename:fileName('a')});
  assert.equal(calls[0].options.headers['x-dsh-gpt-images-token'],nativeOptions.referenceToken);
  assert.match(t.d.querySelector('.dgi-toast').textContent,/已引用到输入框/);
  ref(t).click();await flush();assert.equal(calls.length,1);assert.equal(t.received.length,1);
  assert.match(t.d.querySelector('.dgi-toast').textContent,/已在输入框中/);
 }finally{t.dispose();}
});

test('多图逐张选择、删除后可再引用，已有附件保留',async()=>{
 const t=setup();try{t.w.fetch=async()=>response();await t.settle();ref(t,1).click();await flush();await t.settle();
 assert.equal(t.received[0].file.name,'引用-'+fileName('b'));ref(t,0).click();await flush();await t.settle();
 assert.equal(t.received.length,2);assert.equal(t.d.querySelectorAll('#input-a [role="group"] img').length,3);
 [...t.d.querySelectorAll('#input-a [role="group"] img')].find(i=>i.alt==='引用-'+fileName('b')).remove();
 ref(t,1).click();await flush();await t.settle();assert.equal(t.received.length,3);assert.equal(t.submits(),0);
 }finally{t.dispose();}
});

test('放大预览引用的是当前图片，接收后关闭预览并聚焦输入框',async()=>{
 const t=setup();try{t.w.fetch=async()=>response();await t.settle();t.d.querySelector('.dgi-preview').click();
 const dialog=t.d.querySelector('dialog');dialog.dispatchEvent(new t.w.KeyboardEvent('keydown',{key:'ArrowRight'}));
 dialog.querySelector('button[aria-label="引用"]').click();await flush();await t.settle();
 assert.equal(t.received[0].file.name,'引用-'+fileName('b'));assert.equal(t.d.querySelector('dialog'),null);
 assert.equal(t.d.activeElement,t.d.querySelector('#input-a textarea'));assert.equal(t.submits(),0);
 }finally{t.dispose();}
});

test('下载期间切换会话或替换输入节点，拒绝把图片加到新会话',async()=>{
 for(const change of ['route','composer','source']){const t=setup();try{let finish;t.w.fetch=()=>new Promise(r=>{finish=r;});await t.settle();ref(t).click();
 if(change==='route')t.w.location.hash='#/session-b';
 if(change==='composer'){const input=t.d.querySelector('#input-a textarea');input.replaceWith(input.cloneNode(true));}
 if(change==='source')t.d.querySelector('#message > p').remove();
 finish(response());await flush();await t.settle();assert.equal(t.received.length,0);assert.equal(t.submits(),0);
 }finally{t.dispose();}}
});

test('找不到、只读或不唯一的同会话输入框时不下载或误用全局输入框',async()=>{
 const variants=[
 '<div id="message">'+image('a')+'</div><section data-conversation-scroll>'+card('other')+'</section>',
 '<section data-conversation-scroll><div>'+image('a')+'</div>'+card('one')+card('two')+'</section>',
 '<section data-conversation-scroll><div>'+image('a')+'</div>'+card('one').replace('data-phase="editing"','data-phase="submitting" readonly')+'</section>',
 ];
 for(const html of variants){const t=setup({html});try{let calls=0;t.w.fetch=async()=>{calls++;return response();};await t.settle();ref(t).click();await flush();assert.equal(calls,0);assert.equal(t.received.length,0);assert.match(t.d.querySelector('.dgi-toast').textContent,/未找到可用/);}finally{t.dispose();}}
});

test('同一输入框引用中阻止重复与并发请求',async()=>{
 const t=setup();try{let calls=0,finish;t.w.fetch=()=>{calls++;return new Promise(r=>{finish=r;});};await t.settle();ref(t,0).click();ref(t,1).click();assert.equal(calls,1);
 finish(response());await flush();await t.settle();assert.equal(t.received.length,1);assert.equal(ref(t,0).disabled,false);
 }finally{t.dispose();}
});

test('HTTP失败、坏MIME、空内容和超限图片不进入附件也不报告成功',async()=>{
 const variants=[response({ok:false,json:async()=>({message:'缓存不可用'})}),response({headers:{get:()=> 'text/html'}}),response({arrayBuffer:async()=>new ArrayBuffer(0)}),response({headers:{get:(key)=>key==='content-type'?'image/png':String(999999999)}})];
 for(const result of variants){const t=setup();try{t.w.fetch=async()=>result;await t.settle();ref(t).click();await flush();await t.settle();assert.equal(t.received.length,0);assert.doesNotMatch(t.d.querySelector('.dgi-toast').textContent,/已引用到/);assert.equal(ref(t).disabled,false);}finally{t.dispose();}}
});

test('输入框拒绝图片或没有粘贴处理器时，不能把preventDefault误当引用成功',async()=>{
 for(const options of [{reject:true},{listen:false}]){const t=setup(options);try{t.w.fetch=async()=>response();await t.settle();ref(t).click();await new Promise(r=>setTimeout(r,options.reject?2600:10));assert.equal(t.received.length,0);assert.doesNotMatch(t.d.querySelector('.dgi-toast').textContent,/已引用到/);assert.match(t.d.querySelector('.dgi-toast').textContent,/未接收|不支持/);assert.equal(t.submits(),0);}finally{t.dispose();}}
});

test('卸载画廊中止引用请求，不向残留输入框注入',async()=>{
 const t=setup();try{let signal;t.w.fetch=(_url,options)=>new Promise((_r,reject)=>{signal=options.signal;signal.addEventListener('abort',()=>reject(new Error('已取消')),{once:true});});await t.settle();ref(t).click();t.w.__dshGptImagesGallery.dispose();await flush();assert.equal(signal.aborted,true);assert.equal(t.received.length,0);assert.equal(t.d.querySelector('.dgi-gallery'),null);}finally{t.dispose();}
});

test('React用同URL新节点替换源图片后，保留的引用按钮仍能正常使用',async()=>{
 const t=setup();try{t.w.fetch=async()=>response();await t.settle();const button=ref(t);const image=t.d.querySelector('#message > p img');image.replaceWith(image.cloneNode(true));await t.settle();assert.equal(ref(t),button);button.click();await flush();await t.settle();assert.equal(t.received.length,1);assert.equal(t.received[0].file.name,'引用-'+fileName('a'));}finally{t.dispose();}
});

// Verified against installed ASAR ui-conversation/client.js: ComposerContentEditable
// emits a resident div with these markers, not the older textarea source checkout.
const lexicalCard=(id,attributes='contenteditable="true"')=>'<div data-composer-card id="'+id+'"><div role="group"><img alt="existing.png" src="blob:existing"></div><div data-input-scroll><div><div '+attributes+' role="textbox" aria-multiline="true" data-composer-input="true" data-lexical-editor="true" data-phase="editing"><p><span data-lexical-text="true">已有富文本草稿，不要覆盖</span></p></div></div></div><input type="file" multiple hidden><button type="submit">发送</button></div>';
const lexicalView=(attributes='contenteditable="true"')=>'<main data-conversation-content data-conversation-session="session-a"><section data-conversation-scroll><div id="message">'+image('a')+image('b',2)+'</div>'+lexicalCard('input-a',attributes)+'</section></main>';

test('已安装包的Lexical输入区可引用真实图片附件，并保留富文本草稿和其他附件',async()=>{
 const t=setup({html:lexicalView()});try{let calls=0;t.w.fetch=async()=>{calls++;return response();};await t.settle();const input=t.d.querySelector('[data-composer-input]');const html=input.innerHTML;const text=input.textContent;ref(t,1).click();await flush();await t.settle();assert.equal(calls,1);assert.equal(t.received.length,1);assert.equal(t.received[0].input,input);assert.equal(t.received[0].file.name,'引用-'+fileName('b'));assert.deepEqual(await bytes(t.w,t.received[0].file),Array.from(PNG));assert.equal(input.innerHTML,html);assert.equal(input.textContent,text);assert.equal(t.d.querySelectorAll('#input-a [role="group"] img').length,2);assert.equal(t.submits(),0);assert.equal(t.d.activeElement,input);}finally{t.dispose();}
});

test('Lexical只读、禁用、无会话和两个可编辑输入区不会被误用',async()=>{
 const variants=[lexicalView('contenteditable="false"'),lexicalView('contenteditable="true" aria-disabled="true"'),lexicalView('contenteditable="true" aria-readonly="true"'),lexicalView().replace('data-phase="editing"','data-phase="inert"'),lexicalView().replace('</section>',lexicalCard('other')+'</section>')];
 for(const html of variants){const t=setup({html});try{let calls=0;t.w.fetch=async()=>{calls++;return response();};await t.settle();ref(t).click();await flush();assert.equal(calls,0);assert.equal(t.received.length,0);assert.equal(t.submits(),0);}finally{t.dispose();}}
});

test('Lexical常驻DOM不变但会话ID已切换时，不把图片引用到新会话',async()=>{
 const t=setup({html:lexicalView()});try{let finish;t.w.fetch=()=>new Promise(r=>{finish=r;});await t.settle();ref(t).click();t.d.querySelector('[data-conversation-session]').setAttribute('data-conversation-session','session-b');finish(response());await flush();await t.settle();assert.equal(t.received.length,0);assert.equal(t.submits(),0);}finally{t.dispose();}
});
