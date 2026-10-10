import importlib.util
import random
import unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('intent_sampling',Path(__file__).parents[1]/'intent_sampling.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SamplingTests(unittest.TestCase):
    def rows(self):
        return [{'sourceGroup':group,'request':label>0,'ready':label==2}
                for group,labels in [('a',[0,0,1,2]),('b',[1,1,2])]
                for label in labels]

    def test_default_preserves_one_variant_per_related_group(self):
        rows=self.rows()
        indices=module.sample_epoch(rows,random.Random(42))
        self.assertEqual(len(indices),2)
        self.assertEqual({rows[i]['sourceGroup'] for i in indices},{'a','b'})

    def test_class_sampling_covers_available_contrasts_without_fabricating_classes(self):
        rows=self.rows()
        first=module.sample_epoch(rows,random.Random(42),'group-class')
        self.assertEqual(first,module.sample_epoch(rows,random.Random(42),'group-class'))
        self.assertEqual(len(first),5)
        self.assertEqual({(rows[i]['sourceGroup'],rows[i]['request'],rows[i]['ready']) for i in first},
                         {('a',False,False),('a',True,False),('a',True,True),('b',True,False),('b',True,True)})

    def test_invalid_readiness_without_a_request_is_rejected(self):
        with self.assertRaises(AssertionError):
            module.sample_epoch([{'request':False,'ready':True}],random.Random(42))


if __name__=='__main__':
    unittest.main()
