"""Token-boundary regressions: never drop current constraints to fit history."""
from pathlib import Path
import unittest
import numpy as np
from tokenizers import Tokenizer
from intent_tokens import joint_inputs

class CurrentUtteranceContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tokenizer=Tokenizer.from_file(str(Path(__file__).resolve().parents[1]/'.local/intent-encoder/tokenizer.json'))
        cls.tokenizer.no_truncation();cls.tokenizer.no_padding()

    def assert_current_preserved(self,text,context,context_window='tail'):
        expected=self.tokenizer.encode(text,add_special_tokens=False).ids
        actual=joint_inputs(self.tokenizer,text,context,context_window)
        selected=actual['input_ids'][actual['current_mask'].astype(bool)].tolist()
        self.assertEqual(selected,expected)
        self.assertLessEqual(actual['input_ids'].shape[1],256)
        self.assertEqual(actual['current_mask'][0,0],0)
        self.assertEqual(actual['current_mask'][0,-1],0)
        return actual

    def test_full_boundary_utterance_does_not_lose_its_last_token(self):
        text=' '.join(['a']*253+['z'])
        self.assertEqual(len(self.tokenizer.encode(text,add_special_tokens=False).ids),254)
        actual=self.assert_current_preserved(text,'Earlier conversation '*100)
        self.assertEqual(actual['current_mask'].sum(),254)
        with self.assertRaises(ValueError):joint_inputs(self.tokenizer,text+' a','')

    def test_history_budget_does_not_trim_current_operators_or_identifiers(self):
        self.assert_current_preserved('Explain n_ + 17 <= limit_B in this condition','Earlier conversation '*100)

    def test_empty_and_nontext_inputs_abstain(self):
        for text in ['', '   ', None]:
            with self.assertRaises(ValueError):joint_inputs(self.tokenizer,text,'')

    def test_versioned_history_keeps_head_and_tail_and_marks_the_gap(self):
        context='alpha '+('a '*300)+' omega'
        previous=self.tokenizer.encode(context[-1200:],add_special_tokens=False).ids
        actual=self.assert_current_preserved('Explain the changed constraint',context,'head-tail')
        start=int(np.flatnonzero(actual['current_mask'][0])[0])
        history=actual['input_ids'][0,1:start-1].tolist()
        self.assertEqual(history[0],previous[0]);self.assertEqual(history[-1],previous[-1])
        self.assertIn(self.tokenizer.token_to_id('[SEP]'),history)
        old=joint_inputs(self.tokenizer,'Explain the changed constraint',context)
        self.assertNotEqual(old['input_ids'].tolist(),actual['input_ids'].tolist())

    def test_history_character_bound_does_not_remove_its_beginning_in_v2(self):
        context='alpha '+('a '*900)+' omega'
        actual=self.assert_current_preserved('Explain this',context,'head-tail')
        self.assertEqual(actual['input_ids'][0,1],self.tokenizer.encode('alpha',add_special_tokens=False).ids[0])

    def test_head_tail_never_steals_capacity_from_a_full_current_utterance(self):
        self.assert_current_preserved(' '.join(['a']*253+['z']),'Earlier conversation '*100,'head-tail')

if __name__=='__main__':unittest.main()
