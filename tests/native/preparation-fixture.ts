import assert from "node:assert/strict"
import { chmod, writeFile } from "node:fs/promises"
import { join } from "node:path"

/** A deterministic subprocess exercising the real provider protocol and native pipeline. */
export async function createPreparationHarness(
  root: string,
  live = false,
  stepCount = 2,
  readerLayout = false,
  illustration = ""
) {
  assert(stepCount >= 1 && stepCount <= 64)
  const mode = join(root, "mode")
  const calls = join(root, "calls")
  const executable = live
    ? (process.env.REVIEWBOX_NATIVE_CODEX_EXECUTABLE ?? Bun.which("codex")!)
    : join(root, "codex-fixture")
  assert(executable, "Codex is installed")
  await writeFile(mode, "wait")
  if (!live) {
    await writeFile(
      executable,
      `#!${process.execPath}
import {readFileSync,mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
let currentThread='',currentTurn='',threadCount=0;
const args=process.argv.slice(2),send=value=>{if(value.method&&value.params&&currentThread){value.params.threadId??=currentThread;value.params.turnId??=currentTurn;if(value.params.turn)value.params.turn.id??=currentTurn;}console.log(JSON.stringify(value));};
if(args[0]==='--version'){console.log('codex-cli 0.157.0');process.exit(0)}
if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0)}
if(args.includes('generate-json-schema')){const out=join(args[args.indexOf('--out')+1],'v2');mkdirSync(out,{recursive:true});writeFileSync(join(out,'ThreadStartParams.json'),JSON.stringify({properties:{ephemeral:{type:['boolean','null']}},definitions:{SandboxMode:{enum:['danger-full-access']}}}));process.exit(0)}
const event=(method,item)=>send({method,params:{item}});
for await(const line of createInterface({input:process.stdin})){
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='model/list')send({id:m.id,result:{data:[{id:'gpt-6-sol',model:'gpt-6-sol',displayName:'GPT-6 Sol',description:'Fixture',hidden:false,isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Medium'}],defaultReasoningEffort:'medium'},{id:'gpt-6-luna',model:'gpt-6-luna',displayName:'GPT-6 Luna',hidden:false,supportedReasoningEfforts:[{reasoningEffort:'high',description:'High'}]}],nextCursor:null}});
 if(m.method==='thread/start'){currentThread='thread-'+(++threadCount);send({id:m.id,result:{thread:{id:currentThread,ephemeral:true}}});}
 if(m.method==='thread/unsubscribe')send({id:m.id,result:{status:'unsubscribed'}});
 if(m.method!=='turn/start')continue;
 currentTurn='turn-'+m.id;send({id:m.id,result:{turn:{id:currentTurn}}});
 const prompt=m.params.input[0].text;
 const context=JSON.parse(prompt.split('Context:\\n')[1].split('\\n\\nBatch input:')[0]);
 const batchInput=JSON.parse(prompt.split('Batch input:\\n')[1].split('\\n\\nContract:')[0]);
 const results=[];
 for(const work of batchInput.items??[{id:'single',input:batchInput}]){
 const input=work.input;
 const kind=input.segment?'pseudo':input.scope??'outline';
 appendFileSync(${JSON.stringify(calls)},kind+'\\n');
 send({method:'turn/plan/updated',params:{plan:[{step:'Read the frozen changes',status:'completed'},{step:'Write this batch',status:'inProgress'}]}});
 for(let i=0;i<4;i++){event('item/started',{type:'commandExecution',id:'read-'+i,commandActions:[{type:'read'}]});event('item/completed',{type:'commandExecution',id:'read-'+i,commandActions:[{type:'read'}],status:'completed',exitCode:0});}
 if(kind==='readingStep'){
  event('item/started',{type:'webSearch',id:'unfinished'});
  for(let i=0;i<12;i++)event('item/completed',{type:'agentMessage',id:'note-'+i,phase:'commentary',text:'**Progress note '+i+'**: explaining captured behavior.'});
  while(readFileSync(${JSON.stringify(mode)},'utf8')==='wait')await Bun.sleep(100);
  event('item/completed',{type:'agentMessage',id:'later',phase:'commentary',text:'**Additional activity** arrived.'});
  while(readFileSync(${JSON.stringify(mode)},'utf8')==='more')await Bun.sleep(100);
  if(readFileSync(${JSON.stringify(mode)},'utf8')==='error'){send({method:'turn/completed',params:{turn:{status:'failed'}}});continue;}
 }
 let result;
 if(kind==='outline'){
  const manifest=JSON.parse(readFileSync(context.reviewManifest,'utf8'));
  const changes=manifest.changes.map(c=>JSON.parse(readFileSync(c.metadata,'utf8')));
  result={translationFiles:input.files.filter(file=>!file.path.startsWith('skip-')).map(file=>file.id),topics:[{title:'Captured behavior',brief:'Understand the changed behavior.',steps:Array.from({length:${stepCount}},(_,index)=>({title:index===0?'The new amount':index===1?'The other value':'Behavior '+(index+1),anchors:[changes.find(c=>c.change.path===(index%3===2?'src/other.ts':'src/answer.ts')).anchors[0]]}))}]};
 }else if(kind==='pseudo'){
  result={blocks:[{startLine:input.segment.startLine,endLine:input.segment.endLine,text:'Remember the captured value and make it available.'}]};
 }else{
  const source=input.sources.find(s=>s.sourceId.endsWith(':after'))??input.sources[0];
  const reference={id:'value',label:'value',explanation:'The value made available by this file.',sourceId:source.sourceId,startLine:1,endLine:1};
  const term={id:'assignment',term:'assignment',definition:'Giving a value a name.',context:'This change updates the named value.'};
  result={
   beginner:{body:'The remembered value changes. The surrounding behavior stays available.',references:[],terms:[],readingSeconds:30},
   intermediate:{body:'The [value](reviewbox:ref/value) changes through an [assignment](reviewbox:term/assignment).\\n\\n'+String.fromCharCode(96).repeat(3)+'pseudocode\\nRemember the new value\\n'+String.fromCharCode(96).repeat(3),references:[reference],terms:[term],readingSeconds:45},
   developer:{body:'The [value](reviewbox:ref/value) retains its public role while its [assignment](reviewbox:term/assignment) is updated.\\n\\n'+String.fromCharCode(96).repeat(3)+'source\\nvalue\\n'+String.fromCharCode(96).repeat(3),references:[reference],terms:[term],readingSeconds:60}
  };
 }
 if(${readerLayout}){
  if(kind==='pseudo')result.blocks[0].text=Array.from({length:30},(_,index)=>'Read the captured value, step '+(index+1)).join('\\n');
  else if(kind!=='outline')for(const document of Object.values(result))document.body+='\\n\\n'+Array.from({length:20},(_,index)=>'### Reading detail '+(index+1)+'\\n\\nThe captured behavior remains available throughout this explanation. This paragraph provides enough space to inspect the reading surface while scrolling behind the header and footer.').join('\\n\\n');
 }
 if(kind==='readingStep' && ${JSON.stringify(illustration)}) {
  for(const level of ['beginner','intermediate','developer']) result[level].body+='\\n\\n'+String.fromCharCode(96).repeat(3)+'html\\n'+${JSON.stringify(illustration)}+'\\n'+String.fromCharCode(96).repeat(3);
 }
 results.push({id:work.id,result});
 }
 const finalText=JSON.stringify({items:results});
 event('item/started',{type:'agentMessage',id:'final',phase:'final_answer'});
 send({method:'item/agentMessage/delta',params:{itemId:'final',delta:finalText.slice(0,-1)}});
 if(results.some(r=>r.id.startsWith('step:')))while(readFileSync(${JSON.stringify(mode)},'utf8')==='draft')await Bun.sleep(100);
 send({method:'item/agentMessage/delta',params:{itemId:'final',delta:finalText.slice(-1)}});
 event('item/completed',{type:'agentMessage',id:'final',phase:'final_answer',text:finalText});
 send({method:'turn/plan/updated',params:{plan:[{step:'Read the frozen changes',status:'completed'},{step:'Write this batch',status:'completed'}]}});
 send({method:'turn/completed',params:{turn:{status:'completed'}}});
}
`
    )
    await chmod(executable, 0o700)
  }
  return { mode, calls, executable }
}
