"""Exercise actual fitting/export and checkpoint continuation on a tiny local encoder."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import torch
from tokenizers import Tokenizer
from tokenizers.models import WordPiece
from tokenizers.pre_tokenizers import Whitespace
from transformers import BertConfig, BertModel


class CheckpointContract(unittest.TestCase):
    def test_selected_weights_roundtrip_and_revision_rejection(self):
        root=Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix='checkpoint-test-',dir=root/'.local') as temporary:
            directory=Path(temporary)
            encoder=directory/'encoder';encoder.mkdir()
            torch.manual_seed(9)
            BertModel(BertConfig(vocab_size=12,hidden_size=8,num_hidden_layers=1,
                num_attention_heads=2,intermediate_size=16,max_position_embeddings=256)).save_pretrained(encoder)
            vocabulary={word:index for index,word in enumerate([
                '[PAD]','[UNK]','[CLS]','[SEP]','[MASK]','please','explain','later','hold','thought','go','again'])}
            tokenizer=Tokenizer(WordPiece(vocab=vocabulary,unk_token='[UNK]'))
            tokenizer.pre_tokenizer=Whitespace();tokenizer.save(str(encoder/'tokenizer.json'))
            assets=[{'file':file.name,'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()}
                    for file in encoder.iterdir()]
            (encoder/'manifest.json').write_text(json.dumps({'revision':'local-checkpoint-test','assets':assets}))
            def corpus(file,cases):
                file.write_text(json.dumps({'scope':'Training contract fixture, never production examples',
                    'cases':[{'text':text,'request':request,'ready':ready,'sourceGroup':f'{file.stem}-{index}'}
                             for index,(text,request,ready) in enumerate(cases)]}))
            train=directory/'train.json';validation=directory/'validation.json'
            corpus(train,[('please explain',True,True),('hold thought',False,False)])
            corpus(validation,[('go again',True,True),('later',False,False)])
            checkpoint=directory/'selected.pt'
            base=[sys.executable,str(root/'scripts/train-intent-encoder.py'),'--model',str(encoder),
                '--runtime-models',str(directory),'--train',str(train),'--validation',str(validation),
                '--epochs','1','--threads','1','--batch','2']
            def run(output,*options):
                return subprocess.run(base+['--output',str(output),*map(str,options)],cwd=root,
                    capture_output=True,text=True,timeout=90,env=os.environ.copy())
            first=run(directory/'first','--checkpoint-output',checkpoint)
            self.assertEqual(first.returncode,0,first.stdout+first.stderr)
            saved=torch.load(checkpoint,weights_only=True,map_location='cpu')
            self.assertEqual(saved['selectedEpoch'],1)
            self.assertEqual(saved['format'],'intent-readiness-weights-v1')
            self.assertNotIn('optimizer',saved)
            resumed=run(directory/'resumed','--warm-start',checkpoint,'--context-window','head-tail',
                '--encoder-lr','1e-8','--head-lr','1e-8')
            self.assertEqual(resumed.returncode,0,resumed.stdout+resumed.stderr)
            profile=json.loads((directory/'resumed/profile.fp32.json').read_text())
            self.assertEqual(profile['warmStart']['sha256'],hashlib.sha256(checkpoint.read_bytes()).hexdigest())
            self.assertEqual(profile['epochs'][0]['epoch'],0)
            self.assertEqual(profile['epochs'][0]['sampledTrainingVariants'],0)
            self.assertEqual(profile['encoderLearningRate'],1e-8)
            self.assertEqual(profile['featureSchema'],'finetuned-joint-readiness-v2')
            self.assertEqual(profile['contextWindow'],'head-tail')
            self.assertEqual(profile['exportPredictionDisagreements'],0)
            # Runtime loads the explicitly versioned profile, not the old tail
            # layout. Inference assets are isolated from production models.
            (directory/'tokenizer.json').write_bytes((encoder/'tokenizer.json').read_bytes())
            (directory/'manifest.json').write_text(json.dumps({'revision':'local-checkpoint-test','model':'local-test',
                'assets':[next(asset for asset in assets if asset['file']=='tokenizer.json')]}))
            sys.path.insert(0,str(root/'scripts'))
            spec=importlib.util.spec_from_file_location('checkpoint_worker',root/'scripts/intent-encoder-worker.py')
            worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
            classifier=worker.Classifier(directory,directory/'resumed/profile.fp32.json',threads=1)
            self.assertFalse(classifier.classify('please explain','go '*400)['abstained'])
            saved['encoderRevision']='different-encoder'
            wrong=directory/'wrong.pt';torch.save(saved,wrong)
            rejected=run(directory/'rejected','--warm-start',wrong)
            self.assertNotEqual(rejected.returncode,0)
            self.assertFalse((directory/'rejected').exists())
            # Completed evidence is immutable even if the new call would fit.
            overwritten=run(directory/'first')
            self.assertNotEqual(overwritten.returncode,0)
            self.assertIn('Refusing to overwrite fit evidence',overwritten.stderr)


if __name__=='__main__':unittest.main()
