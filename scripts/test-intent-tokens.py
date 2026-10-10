"""Token-boundary regressions: never drop current constraints to fit history."""
from pathlib import Path
import unittest
from tokenizers import Tokenizer
from intent_tokens import joint_inputs

class CurrentUtteranceContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tokenizer=Tokenizer.from_file(str(Path(__file__).resolve().parents[1]/'.local/intent-encoder/tokenizer.json'))
        cls.tokenizer.no_truncation();cls.tokenizer.no_padding()

    def assert_current_preserved(self,text,context):
        expected=self.tokenizer.encode(text,add_special_tokens=False).ids
        actual=joint_inputs(self.tokenizer,text,context)
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

if __name__=='__main__':unittest.main()
