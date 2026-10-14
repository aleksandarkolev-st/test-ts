import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createService} from '../src/service.mjs';
test('valid order and repeat request',()=>{
  const service=createService({A:4,B:3});
  const order=service.reserve('r1',[{sku:'A',quantity:2}]);
  assert.equal(order.status,'accepted');
  assert.equal(service.reserve('r1',[{sku:'A',quantity:2}]),order);
  assert.deepEqual(service.inventory(),{A:2,B:3});
});
