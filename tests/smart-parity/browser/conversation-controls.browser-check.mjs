// Run explicitly with SMART_PARITY_PLAYWRIGHT_MODULE and SMART_PARITY_CHROMIUM_EXECUTABLE_PATH.
// Uses synthetic HTML in a fresh browser; no service or provider requests.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { bindConversationControls } from './conversation-controls.mjs';
const {chromium}=await import(pathToFileURL(process.env.SMART_PARITY_PLAYWRIGHT_MODULE).href);
const browser=await chromium.launch({executablePath:process.env.SMART_PARITY_CHROMIUM_EXECUTABLE_PATH,headless:true,args:['--no-sandbox']});
const page=await browser.newPage();
const controls='<div data-testid="message-input-root"><textarea></textarea><button data-testid="combined-model-selector">Model A</button><button role="button" aria-label="Send message">Send</button></div>';
const pane=(id,agent,selected,content)=>`<section data-testid="workspace-pane-${id}"><button data-testid="workspace-tab-agent_${agent}" aria-selected="${selected}">Tab</button>${content}</section>`;
try {
 await page.setContent(pane('main','owned',true,`<style>.inactive{display:none}</style><div class="inactive">${controls}</div>${controls}`)+`<aside hidden>${controls}</aside>`+pane('other','foreign',true,controls));
 const bound=await bindConversationControls(page,'owned',1000);
 for(const key of ['model','composer','send']) assert.equal(await page.evaluate(s=>document.querySelectorAll(s).length,bound.selectors[key]),1);
 await page.locator(bound.selectors.composer).fill('owned only');
 assert.equal(await page.locator('[data-testid="workspace-pane-other"] textarea').inputValue(),'');
 await page.locator(bound.selectors.model).click();
 await page.locator(bound.selectors.send).click();
 await page.setContent(pane('main','owned',true,controls+`<div id="transient">${controls}</div>`));
 await page.evaluate(()=>setTimeout(()=>document.getElementById('transient').remove(),100));
 await bindConversationControls(page,'owned',2000);
 for(const [name,html] of [
  ['wrong active agent',pane('main','owned',false,controls)],
  ['hidden selected controls',pane('main','owned',true,`<div hidden>${controls}</div>`)],
  ['two active composers',pane('main','owned',true,controls+controls)],
  ['two matching panes',pane('main','owned',true,controls)+pane('main','other',true,controls)],
 ]) {
  await page.setContent(html);
  if(name==='two matching panes') {
   // An unrelated pane with the same test ID is excluded by its selected-agent binding.
   await bindConversationControls(page,'owned',1000);
  } else await assert.rejects(bindConversationControls(page,'owned',50));
 }
 console.log(JSON.stringify({passed:true,cases:6,nativeCss:true,providerRequests:0}));
} finally {await browser.close();}
