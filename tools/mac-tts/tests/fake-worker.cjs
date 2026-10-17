const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.op==='generate'&&r.input.text==='crash'){process.exit(4);return;}
 if(r.op==='generate'&&r.input.text==='hang')return;
 setTimeout(()=>process.stdout.write(JSON.stringify({id:r.id,event:'done',result:{loaded:r.model?.id,ok:true}})+'\n'),100);
});
