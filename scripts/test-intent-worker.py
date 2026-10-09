"""Black-box sidecar contract tests, including Windows locale failures."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]

class WorkerContract(unittest.TestCase):
    def test_utf8_and_oversize_abstention_do_not_kill_the_worker(self):
        requests = [
            {"id":1,"text":"Explain the ordering of π ≤ 2.","context":"The previous answer said “acquire”—now reconsider it."},
            {"id":2,"text":"Explain " + "allocation "*600 + "without assuming native atomics.","context":""},
            {"id":3,"text":"Explain that again.","context":""},
        ]
        env={**os.environ,"PYTHONIOENCODING":"cp1252","PYTHONUTF8":"0"}
        profile=Path(os.environ.get('COPILOT_INTENT_TEST_PROFILE',ROOT/'.local/intent-encoder/profile.json'))
        result=subprocess.run([sys.executable,str(ROOT/'scripts/intent-encoder-worker.py'),'--models',str(ROOT/'.local/intent-encoder'),'--profile',str(profile)], input=('\n'.join(json.dumps(item,ensure_ascii=False) for item in requests)+'\n').encode('utf-8'),capture_output=True,timeout=10,env=env)
        self.assertEqual(result.returncode,0,result.stderr.decode('utf-8',errors='replace'))
        lines=[json.loads(line) for line in result.stdout.decode('utf-8').splitlines()]
        self.assertEqual(lines[0]['event'],'ready')
        self.assertEqual([line['id'] for line in lines[1:]],[1,2,3])
        self.assertFalse(lines[1]['abstained'])
        self.assertTrue(lines[2]['abstained'])
        self.assertFalse(lines[3]['abstained'])

if __name__ == '__main__':
    unittest.main()
