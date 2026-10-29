/** Validate against the actual shared contract, then check graph references. Node 22+. */
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecipeSchema, WorkflowRefSchema } from '../packages/contract/dist/index.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const load=async path=>JSON.parse(await readFile(path,'utf8'));
let count=0;
for(const file of await readdir(resolve(root,'workflows'),{recursive:true})){
 if(!file.endsWith('.ref.json'))continue;
 const ref=WorkflowRefSchema.parse(await load(resolve(root,'workflows',file)));
 const graph=await load(resolve(root,'workflows',ref.workflow));
 for(const id of ref.outputNodes)if(!graph[id])throw Error(`${file}: missing output ${id}`);
 for(const [name,{node,field}] of Object.entries(ref.inputs)){
  if(!graph[node] || !(field in graph[node].inputs))throw Error(`${file}: invalid input ${name} -> ${node}.${field}`);
 }
 for(const [id,node] of Object.entries(graph))for(const value of Object.values(node.inputs)){
  if(Array.isArray(value)&&typeof value[0]==='string'&&typeof value[1]==='number'&&!graph[value[0]])throw Error(`${file}: missing link ${id} -> ${value[0]}`);
 }
 count++;
}
let recipes=0;
for(const file of await readdir(resolve(root,'recipes'))){
 if(!file.endsWith('.json'))continue;
 const recipe=RecipeSchema.parse(await load(resolve(root,'recipes',file)));
 for(const [step,ref] of Object.entries(recipe.steps)){
  if(step.startsWith('video_') && (!Number.isInteger(ref.params.maxFrames) || ref.params.maxFrames < 1))throw Error(`${file}: missing positive integer ${step} maxFrames`);
  const graph=await load(resolve(root,'workflows',ref.workflow));
  for(const id of ref.outputNodes)if(!graph[id])throw Error(`${file}: missing ${step} output ${id}`);
  for(const {node,field} of Object.values(ref.inputs))if(!graph[node]||!(field in graph[node].inputs))throw Error(`${file}: invalid ${step} input`);
 }
 const destinations=recipe.models.map(m=>`${m.folder}/${m.filename}`);
 if(new Set(destinations).size!==destinations.length)throw Error(`${file}: duplicate model destinations`);
 console.log(`${recipe.tier}: ${Object.keys(recipe.steps).length} steps, ${recipe.models.length} files, ${recipe.models.reduce((a,m)=>a+m.sizeGb,0).toFixed(1)} GB`);
 recipes++;
}
console.log(`Validated ${recipes} recipes and ${count} workflow references.`);

