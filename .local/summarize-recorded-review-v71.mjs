// Run the preserved baseline reporter with only recursive reviewer-input
// serialization corrected. Baseline source and all recording bytes stay intact.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const baseline=path.resolve('scripts/summarize-deep-audio-interview.mjs');
const bytes=await readFile(baseline),source=bytes.toString('utf8');
const old="hash(Buffer.from(JSON.stringify(input)))";
assert.equal(source.split(old).length,2,'Require exactly one unchanged input-hash binding');
const generated=source.replace("'./lib/streamed-word-latency.mjs'","'../scripts/lib/streamed-word-latency.mjs'")
 .replace(old,'hash(Buffer.from(serializeReviewInput(input)))');
const content="import {serializeReviewInput} from './lib/serde-review-input.mjs';\n"+generated;
const generatedFile=path.resolve('.local/generated-recorded-review-summary-v71.mjs');
try{await writeFile(generatedFile,content,{flag:'wx'});}
catch(error){if(error.code!=='EEXIST')throw error;assert.equal(await readFile(generatedFile,'utf8'),content,'Generated reporter changed');}
await import(pathToFileURL(generatedFile));
const output=process.argv[4];assert(output);
const hash=value=>createHash('sha256').update(value).digest('hex');
const collectorFile=fileURLToPath(import.meta.url),serializerFile=fileURLToPath(new URL('./lib/serde-review-input.mjs',import.meta.url));
const provenance={recordedAt:new Date().toISOString(),baseline:{file:baseline,sha256:hash(bytes)},
 generated:{file:generatedFile,sha256:hash(content)},collector:{file:collectorFile,sha256:hash(await readFile(collectorFile))},
 serializer:{file:serializerFile,sha256:hash(await readFile(serializerFile))},
 sourceAndJudgmentsChanged:false,scope:'Baseline summary calculations retained. Input hash uses recursive object-key serialization matching serde_json, with exact values and array order unchanged.'};
await writeFile(path.join(output,'collector-provenance.json'),JSON.stringify(provenance,null,2),{flag:'wx'});
