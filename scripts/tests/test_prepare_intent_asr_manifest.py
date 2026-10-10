import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('prepare_intent_asr_manifest', Path(__file__).parents[1] / 'prepare-intent-asr-manifest.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ManifestTests(unittest.TestCase):
    def test_related_variants_keep_one_group_and_source_labels_are_not_copied(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'source.json'
            path.write_text(json.dumps({'cases': [
                {'text': 'First current utterance', 'episode': 4, 'request': False, 'ready': False},
                {'text': 'Second current utterance', 'episode': 4, 'request': True, 'ready': True},
            ]}), encoding='utf-8')
            rows, _ = module.inputs([path])
            self.assertEqual(rows[0]['sourceGroup'], rows[1]['sourceGroup'])
            self.assertNotEqual(rows[0]['id'], rows[1]['id'])
            self.assertNotIn('ready', rows[1])
            self.assertNotIn('request', rows[1])
            with self.assertRaises(AssertionError):
                module.inputs([path, path])


if __name__ == '__main__':
    unittest.main()
