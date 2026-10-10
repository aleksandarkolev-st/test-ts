"""Offline ASR-style augmentation; never a live intent rule or answer source."""
import argparse
import hashlib
import json
import unicodedata
from pathlib import Path

def without_terminal_punctuation(text):
    text=text.rstrip()
    while text and unicodedata.category(text[-1]).startswith('P'):
        text=text[:-1].rstrip()
    return text

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--input',required=True)
    parser.add_argument('--output',required=True)
    parser.add_argument('--validation')
    parser.add_argument('--asr-only',action='store_true')
    args=parser.parse_args()
    source=Path(args.input);raw=source.read_bytes();data=json.loads(raw)
    key=lambda text:' '.join(without_terminal_punctuation(text).casefold().split())
    excluded=set()
    if args.validation:
        excluded={key(r['text']) for r in json.loads(Path(args.validation).read_text(encoding='utf-8'))['cases']}
    rows=[];seen={};overlap=0
    for index,row in enumerate(data['cases']):
        texts=[without_terminal_punctuation(row['text'])] if args.asr_only else [row['text'],without_terminal_punctuation(row['text'])]
        for text in texts:
            if not text.strip():continue
            if key(text) in excluded:overlap+=1;continue
            identity=(text,row.get('context',''))
            labels=(row['request'],row['ready'])
            if identity in seen:
                if seen[identity]!=labels:raise ValueError(f'Augmentation creates conflicting labels at source case {index}')
                continue
            seen[identity]=labels
            rows.append({**row,'text':text,'sourceCase':index})
    result={'scope':'Synthetic labels with offline terminal-punctuation augmentation to reduce ASR mismatch; no live text normalization, phrase rules, or production examples. Labels retain their source-review limitations.',
        'source':str(source),'sourceSha256':hashlib.sha256(raw).hexdigest(),'sourceScope':data['scope'],
        'transformation':'strip optional terminal Unicode punctuation; current runtime utterances and exact answer code remain unchanged',
        'asrOnly':args.asr_only,'validationOverlapsExcluded':overlap,'cases':rows}
    Path(args.output).write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps({'output':args.output,'sourceCases':len(data['cases']),'cases':len(rows),'validationOverlapsExcluded':overlap}))

if __name__=='__main__':main()
