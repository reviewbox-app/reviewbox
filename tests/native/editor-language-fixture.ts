import { chmod, writeFile } from "node:fs/promises"
import { join } from "node:path"

/** A new language not in the catalogue, using the actual native LSP transport. */
export async function editorLanguageFixture(root: string) {
  const executable = join(root, "example-server")
  const calls = join(root, "live-calls.jsonl")
  await writeFile(
    executable,
    `#!${process.execPath}
import {appendFileSync} from 'node:fs';
let buffer=Buffer.alloc(0),opened=new Map();
const send=value=>{const data=Buffer.from(JSON.stringify({jsonrpc:'2.0',...value}));process.stdout.write('Content-Length: '+data.length+'\\r\\n\\r\\n');process.stdout.write(data)};
for await(const chunk of process.stdin){buffer=Buffer.concat([buffer,chunk]);while(true){
const split=buffer.indexOf('\\r\\n\\r\\n');if(split<0)break;const length=Number(buffer.subarray(0,split).toString().match(/Content-Length:\\s*(\\d+)/i)?.[1]);if(buffer.length<split+4+length)break;
const {id,method,params}=JSON.parse(buffer.subarray(split+4,split+4+length));buffer=buffer.subarray(split+4+length);
appendFileSync(${JSON.stringify(calls)},JSON.stringify({pid:process.pid,method,params,text:opened.get(params?.textDocument?.uri)?.text})+'\\n');
if(method==='textDocument/didOpen')opened.set(params.textDocument.uri,params.textDocument);
if(method==='textDocument/didChange'){const doc=opened.get(params.textDocument.uri);doc.text=params.contentChanges[0].text;doc.version=params.textDocument.version;send({method:'textDocument/publishDiagnostics',params:{uri:doc.uri,version:doc.version,diagnostics:[{range:{start:{line:0,character:0},end:{line:0,character:5}},message:'Live draft diagnostic',severity:2}]}})}
if(id===undefined)continue;let result=null;
if(method==='initialize')result={capabilities:{positionEncoding:'utf-16',textDocumentSync:{openClose:true,change:1,save:true},completionProvider:{},definitionProvider:true,renameProvider:true,documentFormattingProvider:true,codeActionProvider:{codeActionKinds:['source.organizeImports']},hoverProvider:true}};
const fullEdit=(uri,text)=>{const lines=(opened.get(uri)?.text??'').split('\\n');return {range:{start:{line:0,character:0},end:{line:lines.length-1,character:lines.at(-1).length}},newText:text}};
if(method==='textDocument/codeAction'){const uri=params.textDocument.uri,text=opened.get(uri)?.text??'';result=text.includes('savePipeline')?[{title:'Organize fixture imports',kind:'source.organizeImports',edit:{changes:{[uri]:[fullEdit(uri,text.replace('savePipeline','importsApplied'))]}}}]:[]}
if(method==='textDocument/formatting'){const uri=params.textDocument.uri,text=opened.get(uri)?.text??'';result=text.includes('importsApplied')?[fullEdit(uri,text.replace('importsApplied','formattedAfterImports'))]:[]}
if(method==='textDocument/hover')result={contents:'Example hover from the running server'};
if(method==='textDocument/completion')result=[{label:opened.get(params.textDocument.uri)?.text.includes('draft')?'unsavedMember':'diskMember',kind:5}];
if(method==='textDocument/definition')result={uri:params.textDocument.uri.replace(/main\\.exdsl$/,'sibling.exdsl'),range:{start:{line:0,character:0},end:{line:0,character:5}}};
if(method==='textDocument/rename')result={documentChanges:['main.exdsl','sibling.exdsl'].map(name=>{const uri=params.textDocument.uri.replace(/main\\.exdsl$/,name);return {textDocument:{uri,version:opened.get(uri)?.version??null},edits:[{range:{start:{line:0,character:0},end:{line:0,character:5}},newText:params.newName}]}})};
send({id,result});
}}
`
  )
  await chmod(executable, 0o700)
  return {
    calls,
    manifest: {
      id: "example-dsl",
      name: "Example DSL",
      version: "1.0.0",
      sourceUrl: "https://example.org/language",
      languages: [
        {
          id: "example-dsl",
          name: "Example DSL",
          lspId: "example-dsl",
          extensions: ["exdsl"],
          filenames: [],
          aliases: [],
        },
      ],
      rootMarkers: ["example.config.json"],
      watchedFiles: ["**/*.exdsl", "**/example.config.json"],
      server: {
        installation: { kind: "executable", executable },
        arguments: [],
        settings: {},
      },
      grammars: [
        {
          name: "example-dsl",
          scopeName: "source.example",
          patterns: [{ match: "\\bhello\\b", name: "keyword.example" }],
        },
      ],
      enabled: true,
    },
  }
}

export async function plannerFixture(root: string) {
  const executable = join(root, "planner"),
    calls = join(root, "planner-calls.jsonl")
  await writeFile(
    executable,
    `#!${process.execPath}
import {createInterface} from 'node:readline';import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
const args=process.argv.slice(2),send=v=>console.log(JSON.stringify(v));
if(args[0]==='--version'){console.log('codex-cli 0.157.0');process.exit(0)}
if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0)}
if(args.includes('generate-json-schema')){const dir=join(args[args.indexOf('--out')+1],'v2');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'ThreadStartParams.json'),JSON.stringify({properties:{ephemeral:{type:['boolean','null']}},definitions:{SandboxMode:{enum:['read-only','danger-full-access']}}}));process.exit(0)}
for await(const line of createInterface({input:process.stdin})) { const m=JSON.parse(line);appendFileSync(${JSON.stringify(calls)},JSON.stringify(m)+'\\n');
if(m.method==='initialize')send({id:m.id,result:{}});
if(m.method==='model/list')send({id:m.id,result:{data:[{id:'gpt-6.1-sol',model:'gpt-6.1-sol',displayName:'Fixture model',hidden:false,supportedReasoningEfforts:[{reasoningEffort:'medium'}]}],nextCursor:null}});
if(m.method==='config/read')send({id:m.id,result:{config:{mcp_servers:{writer:{enabled:true}},apps:{writer:{enabled:true}}}}});
if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'plan-thread',ephemeral:true}}});
if(m.method==='thread/unsubscribe')send({id:m.id,result:{status:'unsubscribed'}});
if(m.method==='turn/start'){
const plan={id:'',repositoryId:'',path:'',summary:'Add a reviewed project configuration',prerequisites:[],pack:null,serverId:'example-dsl',files:[{path:'language-config.json',before:null,after:'{"configured":true}\\n',expectedRevision:null}],commands:[]};
send({id:m.id,result:{turn:{id:'plan-turn'}}});send({method:'item/completed',params:{threadId:'plan-thread',turnId:'plan-turn',item:{type:'agentMessage',id:'plan-result',phase:'final_answer',text:JSON.stringify(plan)}}});send({method:'turn/completed',params:{threadId:'plan-thread',turn:{id:'plan-turn',status:'completed'}}});
}}
`
  )
  await chmod(executable, 0o700)
  return { executable, calls }
}
