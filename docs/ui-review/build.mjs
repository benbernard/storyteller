import fs from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url)),output=resolve(process.argv[2]??join(root,'../../.agent-scratch/ui-review'));
await fs.mkdir(output,{recursive:true});
const mascot='data:image/png;base64,'+(await fs.readFile(join(root,'../../tools/audiobooks/listener-web/storyteller-mark.png'))).toString('base64');
let html=await fs.readFile(join(root,'index.html'),'utf8');
const css=await fs.readFile(join(root,'review.css'),'utf8'),js=(await fs.readFile(join(root,'review.js'),'utf8')).replaceAll('../../tools/audiobooks/listener-web/storyteller-mark.png',mascot);
html=html.replace('<link rel="stylesheet" href="review.css">',`<style>${css}</style>`).replace('<script src="review.js" defer></script>',`<script>${js.replaceAll('</script>','<\\/script>')}</script>`).replaceAll('../../tools/audiobooks/listener-web/storyteller-mark.png',mascot);
// The inline script waits until its DOM exists, matching the source's defer.
html=html.replace('<script>', '<script>document.addEventListener("DOMContentLoaded",()=>{').replace('</script>','});</script>');
await fs.writeFile(join(output,'storyteller-design-review.html'),html);
console.log(JSON.stringify({output:join(output,'storyteller-design-review.html'),selfContained:true,privateBookContent:false}));
