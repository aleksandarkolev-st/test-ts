import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('split_intent_asr', Path(__file__).parents[1] / 'split-intent-asr.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def row(text, group):
    return {'text': text, 'sourceGroup': group, 'request': True, 'ready': True}


class SplitTests(unittest.TestCase):
    def test_whole_groups_are_reserved_and_exact_text_overlap_is_removed(self):
        base = {'cases': [row('shared current words', 'base'), row('old distinct words', 'base')]}
        development = {'cases': [row('development words', 'development')]}
        prefixes = {'cases': [row('new training words', 'train'), row('development words', 'train'),
                              row('shared current words', 'eval'), row('another evaluation variant', 'eval')]}
        result = module.assemble(prefixes, base, development, {'train': 'training', 'eval': 'validation'})
        self.assertEqual([item['text'] for item in result['training']['cases']], ['old distinct words', 'new training words'])
        self.assertEqual(len(result['evaluation']['cases']), 2)
        self.assertEqual(result['audit']['exactTextOverlapsExcludedFromTraining'], 2)

    def test_unknown_or_previously_used_evaluation_groups_are_rejected(self):
        base = {'cases': [row('base words', 'base')]}
        development = {'cases': [row('development words', 'development')]}
        prefixes = {'cases': [row('training words', 'train'), row('evaluation words', 'eval')]}
        for roles in ({'train': 'training', 'base': 'validation'}, {'train': 'training', 'development': 'validation'}):
            with self.assertRaises(AssertionError):
                module.assemble(prefixes, base, development, roles)
        with self.assertRaises(AssertionError):
            module.assemble(prefixes, base, development, {'different': 'training', 'eval': 'validation'})


if __name__ == '__main__':
    unittest.main()
