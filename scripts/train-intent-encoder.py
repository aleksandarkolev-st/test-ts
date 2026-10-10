"""Fine-tune a small contextual CPU classifier; never generates answers."""
import argparse
import copy
import hashlib
import json
import random
import time
from pathlib import Path
import numpy as np
import torch
import transformers
from transformers import BertModel
from tokenizers import Tokenizer
import onnxruntime as ort
from onnxruntime.quantization import quantize_dynamic, QuantType
from intent_tokens import joint_inputs

class Readiness(torch.nn.Module):
    def __init__(self, model):
        super().__init__()
        self.encoder=BertModel.from_pretrained(model,local_files_only=True,
            use_safetensors=True,add_pooling_layer=False,attn_implementation="eager")
        self.dropout=torch.nn.Dropout(0.1)
        self.head=torch.nn.Linear(self.encoder.config.hidden_size*3,3)

    def forward(self,input_ids,attention_mask,token_type_ids,current_mask):
        hidden=self.encoder(input_ids=input_ids,attention_mask=attention_mask,
            token_type_ids=token_type_ids,return_dict=False)[0]
        mask=current_mask.unsqueeze(-1).to(hidden.dtype)
        mean=(hidden*mask).sum(dim=1)/mask.sum(dim=1).clamp(min=1)
        positions=torch.arange(hidden.shape[1],device=hidden.device).unsqueeze(0)
        last_at=(positions*current_mask).max(dim=1).values
        last=hidden.gather(1,last_at[:,None,None].expand(-1,1,hidden.shape[-1])).squeeze(1)
        return self.head(self.dropout(torch.cat([hidden[:,0],mean,last],dim=1)))

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--model',default='.local/intent-training-model')
    parser.add_argument('--train',required=True)
    parser.add_argument('--validation',required=True)
    parser.add_argument('--output',required=True)
    parser.add_argument('--runtime-models',default='.local/intent-encoder')
    parser.add_argument('--epochs',type=int,default=10)
    parser.add_argument('--batch',type=int,default=8)
    parser.add_argument('--threads',type=int,default=4)
    args=parser.parse_args()
    assert 1<=args.epochs<=50 and 1<=args.batch<=64 and 1<=args.threads<=16
    torch.set_num_threads(args.threads);torch.set_num_interop_threads(1)
    torch.manual_seed(42);random.seed(42);np.random.seed(42)
    model_dir=Path(args.model);manifest=json.loads((model_dir/'manifest.json').read_text(encoding='utf-8'))
    for asset in manifest['assets']:
        path=(model_dir/asset['file']).resolve()
        assert model_dir.resolve() in path.parents
        raw=path.read_bytes()
        assert len(raw)==asset['bytes'] and hashlib.sha256(raw).hexdigest()==asset['sha256']
    def read(file):
        raw=Path(file).read_bytes();data=json.loads(raw)
        return data,hashlib.sha256(raw).hexdigest()
    training,train_sha=read(args.train);validation,val_sha=read(args.validation)
    key=lambda r:' '.join(r['text'].casefold().split())
    assert not {key(r) for r in training['cases']} & {key(r) for r in validation['cases']}
    train_groups={r['sourceGroup'] for r in training['cases'] if 'sourceGroup' in r}
    validation_groups={r['sourceGroup'] for r in validation['cases'] if 'sourceGroup' in r}
    assert not train_groups & validation_groups, 'Related source groups cross the training/validation split'
    tokenizer=Tokenizer.from_file(str(model_dir/'tokenizer.json'))
    tokenizer.no_truncation();tokenizer.no_padding()
    def encode(rows):
        items=[]
        for row in rows:
            assert isinstance(row['request'],bool) and isinstance(row['ready'],bool)
            assert not row['ready'] or row['request']
            items.append((joint_inputs(tokenizer,row['text'],row.get('context','')),
                2 if row['ready'] else 1 if row['request'] else 0))
        return items
    train=encode(training['cases']);valid=encode(validation['cases'])
    groups={}
    for index,row in enumerate(training['cases']):
        groups.setdefault(row.get('sourceGroup',row.get('sourceCase',index)),[]).append(index)
    def batch(items,indices):
        width=max(items[i][0]['input_ids'].shape[1] for i in indices)
        tensors={name:torch.as_tensor(np.concatenate([np.pad(items[i][0][name],((0,0),(0,width-items[i][0][name].shape[1]))) for i in indices],axis=0)) for name in items[0][0]}
        return tensors,torch.tensor([items[i][1] for i in indices])
    model=Readiness(str(model_dir))
    optimizer=torch.optim.AdamW([
        {'params':model.encoder.parameters(),'lr':2e-5},
        {'params':model.head.parameters(),'lr':2e-4}],weight_decay=0.01)
    def predictions():
        model.eval();result=[]
        with torch.inference_mode():
            for start in range(0,len(valid),args.batch):
                tensors,_=batch(valid,list(range(start,min(len(valid),start+args.batch))))
                result.append(model(**tensors))
        return torch.cat(result)
    labels=torch.tensor([item[1] for item in valid])
    best_loss=float('inf');best=None;stale=0;epochs=[];started=time.monotonic()
    for epoch in range(args.epochs):
        indices=[random.choice(group) for group in groups.values()];random.shuffle(indices)
        model.train();total=0
        for start in range(0,len(indices),args.batch):
            selected=indices[start:start+args.batch];tensors,targets=batch(train,selected)
            optimizer.zero_grad(set_to_none=True)
            loss=torch.nn.functional.cross_entropy(model(**tensors),targets)
            loss.backward();torch.nn.utils.clip_grad_norm_(model.parameters(),1.0);optimizer.step()
            total+=float(loss.detach())*len(selected)
        logits=predictions();loss=float(torch.nn.functional.cross_entropy(logits,labels))
        row={'epoch':epoch+1,'trainingLoss':total/len(indices),'validationLoss':loss,
            'validationAccuracy':float((logits.argmax(dim=1)==labels).float().mean()),
            'elapsedSeconds':time.monotonic()-started}
        epochs.append(row);print(json.dumps(row),flush=True)
        if loss<best_loss:
            best_loss=loss;best=copy.deepcopy(model.state_dict());selected_epoch=epoch+1;stale=0
        else:
            stale+=1
            if stale>=3:break
    model.load_state_dict(best);model.eval()
    output=Path(args.output);output.mkdir(parents=True,exist_ok=True)
    sample,_=batch(valid,[0])
    names=list(sample);full=output/'model.fp32.onnx';quantized=output/'model.int8.onnx'
    torch.onnx.export(model,tuple(sample.values()),str(full),input_names=names,output_names=['logits'],
        dynamic_axes={**{name:{0:'batch',1:'sequence'} for name in names},'logits':{0:'batch'}},opset_version=17,dynamo=False)
    quantize_dynamic(str(full),str(quantized),per_channel=True,weight_type=QuantType.QInt8,op_types_to_quantize=['MatMul','Gemm'])
    options=ort.SessionOptions();options.intra_op_num_threads=2;options.inter_op_num_threads=1
    options.execution_mode=ort.ExecutionMode.ORT_SEQUENTIAL
    native=predictions().numpy()
    def exported_logits(file):
        session=ort.InferenceSession(str(file),options,providers=['CPUExecutionProvider'])
        return np.concatenate([session.run(None,item[0])[0] for item in valid])
    full_logits=exported_logits(full)
    full_difference=float(np.abs(native-full_logits).max())
    full_disagreements=int((native.argmax(axis=1)!=full_logits.argmax(axis=1)).sum())
    if full_difference>1e-3 or full_disagreements:
        raise ValueError(f'FP32 export failed parity: max logit difference {full_difference}, disagreements {full_disagreements}')
    exported=exported_logits(quantized)
    def nll(logits,temperature):
        scaled=logits/temperature;scaled-=scaled.max(axis=1,keepdims=True)
        probability=np.exp(scaled);probability/=probability.sum(axis=1,keepdims=True)
        return float(-np.log(np.maximum(probability[np.arange(len(valid)),labels.numpy()],1e-9)).mean())
    temperature=min(np.linspace(0.5,3.0,51),key=lambda value:nll(exported,value))
    raw=quantized.read_bytes()
    result={'encoder':manifest['revision'],'featureSchema':'finetuned-joint-readiness-v1',
        'classes':['background','unfinished_request','ready_request'],
        'trainedModel':{'file':quantized.resolve().relative_to(Path(args.runtime_models).resolve()).as_posix(),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()},
        'temperature':float(temperature),'validationLoss':nll(exported,temperature),
        'validationAccuracy':float((exported.argmax(axis=1)==labels.numpy()).mean()),
        'maxExportLogitDifference':float(np.abs(native-exported).max()),
        'exportPredictionDisagreements':int((native.argmax(axis=1)!=exported.argmax(axis=1)).sum()),
        'fp32ExportMaxLogitDifference':full_difference,'fp32ExportPredictionDisagreements':full_disagreements,
        'trainingSha256':train_sha,'validationSha256':val_sha,'trainingVariants':len(train),
        'trainingOriginalGroups':len(groups),'validationCount':len(valid),'seed':42,'selectedEpoch':selected_epoch,
        'trainingThreads':args.threads,'epochs':epochs,'torch':torch.__version__,'transformers':transformers.__version__,
        'sourceModelManifest':manifest,'scope':'Offline supervised fine-tuning. Assistant-reviewed synthetic labels; not human certification. Validation selects epoch and temperature. One variant per original example per epoch. No phrase rules or answers in inference.'}
    (output/'profile.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    full_raw=full.read_bytes()
    full_temperature=min(np.linspace(0.5,3.0,51),key=lambda value:nll(full_logits,value))
    full_profile={**result,'trainedModel':{'file':full.resolve().relative_to(Path(args.runtime_models).resolve()).as_posix(),
        'bytes':len(full_raw),'sha256':hashlib.sha256(full_raw).hexdigest()},
        'temperature':float(full_temperature),'validationLoss':nll(full_logits,full_temperature),
        'validationAccuracy':float((full_logits.argmax(axis=1)==labels.numpy()).mean()),
        'maxExportLogitDifference':full_difference,'exportPredictionDisagreements':full_disagreements}
    (output/'profile.fp32.json').write_text(json.dumps(full_profile,indent=2),encoding='utf-8')
    print(json.dumps({k:result[k] for k in ['validationLoss','validationAccuracy','selectedEpoch','temperature','maxExportLogitDifference','exportPredictionDisagreements']}),flush=True)

if __name__=='__main__':main()
