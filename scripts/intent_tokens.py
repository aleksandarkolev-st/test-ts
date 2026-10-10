"""Shared tokenization for offline training and CPU intent inference; no rules."""
import numpy as np

def joint_inputs(tokenizer, text, context=""):
    if not isinstance(text,str) or not text.strip() or len(text)>32000 or not isinstance(context,str):
        raise ValueError("Invalid utterance")
    current=tokenizer.encode(text,add_special_tokens=False).ids
    if not current or len(current)>254:
        raise ValueError("input_limit")
    previous=tokenizer.encode(context[-1200:],add_special_tokens=False).ids
    budget=253-len(current)
    history=previous[-budget:] if budget>0 else []
    cls=tokenizer.token_to_id("[CLS]");sep=tokenizer.token_to_id("[SEP]")
    if cls is None or sep is None:
        raise ValueError("Unsupported encoder tokenizer")
    if history:
        ids=[cls]+history+[sep]+current+[sep]
        split=len(history)+2
        types=[0]*split+[1]*(len(current)+1)
    else:
        ids=[cls]+current+[sep];split=1;types=[0]*len(ids)
    mask=[0]*split+[1]*len(current)+[0]
    return {"input_ids":np.asarray([ids],dtype=np.int64),
        "attention_mask":np.ones((1,len(ids)),dtype=np.int64),
        "token_type_ids":np.asarray([types],dtype=np.int64),
        "current_mask":np.asarray([mask],dtype=np.int64)}
