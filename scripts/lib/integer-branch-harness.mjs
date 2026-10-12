import assert from 'node:assert/strict';

// Independent evaluation contract. The submitted function remains unchanged;
// only an external test main is added. No answer-specific production routing.
export function integerBranchHarness(code, contract) {
 assert(/^[A-Za-z_]\w*$/.test(contract.function));
 assert(['<','<=','>','>=','==','!='].includes(contract.operator));
 for(const key of ['threshold','whenTrue','whenFalse','minimum','maximum'])
  assert(Number.isSafeInteger(contract[key])&&contract[key]>=-2147483648&&contract[key]<=2147483647);
 assert(contract.minimum<=contract.maximum&&contract.maximum-contract.minimum<=100000);
 const literal=value=>value===-2147483648?'(-2147483647 - 1)':String(value);
 const expected=`x ${contract.operator} ${literal(contract.threshold)} ? ${literal(contract.whenTrue)} : ${literal(contract.whenFalse)}`;
 return '#include <climits>\n#include <initializer_list>\n'+code+
  `\nint main(){for(long long value=${literal(contract.minimum)};value<=${literal(contract.maximum)};++value){int x=static_cast<int>(value);if(${contract.function}(x)!=(${expected}))return 2;}`+
  `for(int x:{INT_MIN,INT_MAX}){if(${contract.function}(x)!=(${expected}))return 2;}return 0;}\n`;
}
