import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopInput } from '../dist/serve/desktop-input.js';
import { createInputMultiplexer } from '../dist/agent/input-queue.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=';
const attachment = [{ path: `data:image/png;base64,${png}` }];
test('desktop input carries typed image bytes without embedding base64 in prompt text', () => {
  const input = desktopInput(' What is pictured? ', attachment);
  assert.equal(input.text, 'What is pictured?');
  assert.deepEqual(input.images, [{ type:'image', source:{ type:'base64', media_type:'image/png', data:png } }]);
  assert.equal(desktopInput('', attachment).text, 'Describe the attached image.');
  assert.equal(desktopInput('plain text', undefined), 'plain text');
  assert.throws(() => desktopInput('', undefined), /empty input/);
});
test('rejects remote paths, invalid image types, malformed base64 and oversized attachments', () => {
  for (const value of ['/etc/passwd', 'https://example.com/x.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,bm90IGEgcG5n', `data:image/png;base64,${png.slice(0,-1)}`, 'data:image/png;base64,'+'A'.repeat(5_333_400)]) {
    assert.throws(() => desktopInput('test', [{path:value}]));
  }
  assert.throws(() => desktopInput('test', [...attachment,...attachment]));
  assert.throws(() => desktopInput('test', {}));
});
test('queued scheduler input never steals images belonging to pending desktop input', async () => {
  let resolve;
  const mux = createInputMultiplexer(() => new Promise(r => {resolve=r;}));
  const pending = mux.getUserInput();
  mux.enqueue('scheduled text');
  assert.equal(await pending, 'scheduled text');
  const image = desktopInput('user image', attachment);
  resolve(image);
  assert.deepEqual(await mux.getUserInput(), image);
});
test('grounding evaluator knows about supplied visual evidence without treating it as live external data', async () => {
  const { checkGrounding } = await import('../dist/agent/evaluator.js');
  const requests = [];
  const client = { complete: async request => {
    requests.push(request);
    return {content:[{type:'text',text:'VERDICT: GROUNDED'}]};
  }};
  const history = [{role:'user',content:'Earlier question'}, {role:'assistant',content:[{type:'tool_use',id:'old',name:'WebSearch',input:{query:'old evidence'}}]}, {role:'user',content:[{type:'text',text:'Describe screenshot'},...desktopInput('',attachment).images]}];
  await checkGrounding('Describe screenshot',history,'A blue rectangle.',client,{userImageCount:1});
  const summary = requests[0].messages[0].content;
  assert.match(summary,/User-provided images: 1/);
  assert.doesNotMatch(summary,/old evidence/);
  assert.doesNotMatch(summary,new RegExp(png.slice(0,20)));
  assert.match(requests[0].system,/Images do NOT establish fresh external facts/);
  await checkGrounding('What is the current price?',history,'It is $10.',client);
  assert.doesNotMatch(requests[1].messages[0].content,/User-provided images:/);
});
