"""Small supervised neural head; validation-only selection, no phrase rules."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from importlib.util import spec_from_file_location, module_from_spec

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--models',default='.local/intent-encoder')
    parser.add_argument('--train',required=True)
    parser.add_argument('--validation',required=True)
    parser.add_argument('--output',required=True)
    parser.add_argument('--joint',action='store_true')
    args=parser.parse_args()
    spec=spec_from_file_location('encoder',Path(__file__).with_name('intent-encoder-worker.py'))
    module=module_from_spec(spec);spec.loader.exec_module(module)
    encoder=module.Encoder(args.models)
    training=json.loads(Path(args.train).read_text(encoding='utf-8'))
    validation=json.loads(Path(args.validation).read_text(encoding='utf-8'))
    assert not {r['text'] for r in training['cases']} & {r['text'] for r in validation['cases']}
    def vectorize(rows):
        x=np.asarray([encoder.features(r['text'],r.get('context',''),joint=args.joint)[0] for r in rows],dtype=np.float32)
        y=np.asarray([2 if r['ready'] else 1 if r['request'] else 0 for r in rows])
        return x,y
    x,y=vectorize(training['cases']);vx,vy=vectorize(validation['cases'])
    mean=x.mean(axis=0);scale=np.maximum(x.std(axis=0),0.01)
    x=(x-mean)/scale;vx=(vx-mean)/scale;targets=np.eye(3)[y]
    def softmax(logits):
        e=np.exp(logits-logits.max(axis=1,keepdims=True));return e/e.sum(axis=1,keepdims=True)
    best=None
    for regularization in [0.001,0.01,0.1]:
        rng=np.random.default_rng(42)
        parameters=[rng.normal(0,1/np.sqrt(x.shape[1]),(x.shape[1],32)).astype(np.float32),np.zeros(32,dtype=np.float32),rng.normal(0,1/np.sqrt(32),(32,3)).astype(np.float32),np.zeros(3,dtype=np.float32)]
        first=[np.zeros_like(p) for p in parameters];second=[np.zeros_like(p) for p in parameters]
        local_best=float('inf');stale=0
        for step in range(1,601):
            w1,b1,w2,b2=parameters
            hidden=np.tanh(x@w1+b1);difference=(softmax(hidden@w2+b2)-targets)/len(y)
            back=(difference@w2.T)*(1-hidden*hidden)
            gradients=[x.T@back+regularization*w1,back.sum(axis=0),hidden.T@difference+regularization*w2,difference.sum(axis=0)]
            for i,(parameter,gradient) in enumerate(zip(parameters,gradients)):
                first[i]=0.9*first[i]+0.1*gradient
                second[i]=0.999*second[i]+0.001*gradient*gradient
                parameter-=0.01*(first[i]/(1-0.9**step))/(np.sqrt(second[i]/(1-0.999**step))+1e-8)
            if step%10:continue
            probability=softmax(np.tanh(vx@parameters[0]+parameters[1])@parameters[2]+parameters[3])
            loss=float(-np.log(np.maximum(probability[np.arange(len(vy)),vy],1e-9)).mean())
            if best is None or loss<best[0]:best=(loss,regularization,step,[p.copy() for p in parameters],float((probability.argmax(axis=1)==vy).mean()))
            if loss<local_best:local_best=loss;stale=0
            else:stale+=1
            if stale>=10:break
    loss,regularization,step,parameters,accuracy=best
    profile={'encoder':encoder.identity['revision'],'featureSchema':'joint-current-last-context-untruncated-v1' if args.joint else 'mean-last-context-untruncated-v1','classes':['background','unfinished_request','ready_request'],
        'headKind':'mlp-tanh-v1','hiddenWeights':parameters[0].tolist(),'hiddenBias':parameters[1].tolist(),'weights':parameters[2].tolist(),'bias':parameters[3].tolist(),'featureMean':mean.tolist(),'featureScale':scale.tolist(),
        'validationLoss':loss,'validationAccuracy':accuracy,'regularization':regularization,'selectedStep':step,'seed':42,
        'trainingSha256':hashlib.sha256(Path(args.train).read_bytes()).hexdigest(),'validationSha256':hashlib.sha256(Path(args.validation).read_bytes()).hexdigest(),'trainingCount':len(y),'validationCount':len(vy),
        'scope':'Assistant-reviewed synthetic supervised data; not human certification. Validation chooses parameters; test examples are never training or routing data.'}
    Path(args.output).write_text(json.dumps(profile),encoding='utf-8')
    print(json.dumps({'profile':args.output,'validationLoss':loss,'validationAccuracy':accuracy,'regularization':regularization,'selectedStep':step}),flush=True)

if __name__=='__main__':main()
