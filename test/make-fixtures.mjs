// One-shot generator: builds ABI-encoded hex results for the mock RPC fixture.
// Run: node test/make-fixtures.mjs  (output written to test/fixtures/rpc-fixtures.json)
import { encodeFunctionResult, toFunctionSelector } from 'viem';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
mkdirSync(dir, { recursive: true });

const fixture = {
  _comment: 'ABI-encoded eth_call results used by mock RPC in tests. Selectors of zero-arg view functions.',
  selectors: Object.fromEntries(
    ['name', 'symbol', 'totalSupply', 'maxSupply', 'cost', 'owner', 'pause'].map((n) => [n, toFunctionSelector(`${n}()`)]),
  ),
  contracts: {
    demoApe: {
      name: encodeFunctionResult({ abi: [{ type: 'function', name: 'name', outputs: [{ type: 'string' }] }], functionName: 'name', result: 'Demo Ape Club' }),
      symbol: encodeFunctionResult({ abi: [{ type: 'function', name: 'symbol', outputs: [{ type: 'string' }] }], functionName: 'symbol', result: 'DAPE' }),
      totalSupply: encodeFunctionResult({ abi: [{ type: 'function', name: 'totalSupply', outputs: [{ type: 'uint256' }] }], functionName: 'totalSupply', result: 1234n }),
      maxSupply: encodeFunctionResult({ abi: [{ type: 'function', name: 'maxSupply', outputs: [{ type: 'uint256' }] }], functionName: 'maxSupply', result: 5000n }),
      cost: encodeFunctionResult({ abi: [{ type: 'function', name: 'cost', outputs: [{ type: 'uint256' }] }], functionName: 'cost', result: 5000000000000000n }),
    },
    freeMint: {
      name: encodeFunctionResult({ abi: [{ type: 'function', name: 'name', outputs: [{ type: 'string' }] }], functionName: 'name', result: 'Free Foxes' }),
      symbol: encodeFunctionResult({ abi: [{ type: 'function', name: 'symbol', outputs: [{ type: 'string' }] }], functionName: 'symbol', result: 'FOX' }),
      totalSupply: encodeFunctionResult({ abi: [{ type: 'function', name: 'totalSupply', outputs: [{ type: 'uint256' }] }], functionName: 'totalSupply', result: 99n }),
      maxSupply: encodeFunctionResult({ abi: [{ type: 'function', name: 'maxSupply', outputs: [{ type: 'uint256' }] }], functionName: 'maxSupply', result: 100n }),
    },
  },
};

writeFileSync(join(dir, 'rpc-fixtures.json'), JSON.stringify(fixture, null, 2));
console.log('wrote', join(dir, 'rpc-fixtures.json'));
