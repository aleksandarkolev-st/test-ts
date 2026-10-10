"""Data integrity and non-clairvoyant annotation contract."""
import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('prepare_intent_asr', Path(__file__).parents[1] / 'prepare-intent-asr.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PrepareTests(unittest.TestCase):
    def records(self):
        return [
            {'type': 'capture.started', 'schemaVersion': 1, 'utteranceCount': 1},
            {'type': 'utterance.started', 'id': 'a', 'sourceGroup': 'shared-episode',
             'context': 'Previous exchange only', 'waveSha256': 'hash', 'text': 'Future words', 'ready': True},
            {'type': 'candidate', 'id': 'a', 'text': 'Current words', 'observedAtMs': 300,
             'floor': 0, 'remoteQuiet': False, 'remoteSpeaking': True},
            {'type': 'utterance.finished', 'id': 'a', 'complete': True, 'lastSpeechEndMs': 600, 'lastFinalEndMs': 610},
            {'type': 'capture.finished', 'complete': True},
        ]

    def prepare(self, rows):
        return module.prepare(('\n'.join(json.dumps(row) for row in rows)).encode(), 4, 250, 61)

    def test_only_available_words_and_prior_context_are_exported(self):
        result = self.prepare(self.records())
        case = result['cases'][0]
        self.assertEqual(case['text'], 'Current words')
        self.assertEqual(case['sourceGroup'], 'shared-episode')
        self.assertNotIn('ready', case)
        self.assertNotIn('Future words', json.dumps(result))
        self.assertEqual(result['originalCases'], [])

    def test_incomplete_capture_and_unclosed_or_crossed_utterances_are_rejected(self):
        for change in ('footer', 'utterance', 'endpoint', 'id'):
            rows = self.records()
            if change == 'footer': rows[-1]['complete'] = False
            if change == 'utterance': rows[-2]['complete'] = False
            if change == 'endpoint': rows[-2]['lastFinalEndMs'] = 599
            if change == 'id': rows[2]['id'] = 'other'
            with self.assertRaises(AssertionError):
                self.prepare(rows)


if __name__ == '__main__':
    unittest.main()
