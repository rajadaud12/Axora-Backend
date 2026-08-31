import 'dotenv/config';
import { createPublicClient, http } from 'viem';
import { arbitrumSepolia } from 'viem/chains';

const rpcUrl = process.env.ALCHEMY_RPC_URL || 'https://arbitrum-sepolia.publicnode.com';

const client = createPublicClient({ 
  chain: arbitrumSepolia, 
  transport: http(rpcUrl) 
});

const USER = '0xc23f158AF4d96b0E2a1846d8E29F3dB1670a942F';
const POOL = '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff';
const USDC = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const AUSDC = '0x460b97BD498E1157530AEb3086301d5225b91216';

const poolAbi = [{ type: 'function', name: 'getReserveData', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }], outputs: [{ type: 'tuple', components: [{ name: 'configuration', type: 'uint256' },{ name: 'liquidityIndex', type: 'uint128' },{ name: 'currentLiquidityRate', type: 'uint128' },{ name: 'variableBorrowIndex', type: 'uint128' },{ name: 'currentVariableBorrowRate', type: 'uint128' },{ name: 'currentStableBorrowRate', type: 'uint128' },{ name: 'lastUpdateTimestamp', type: 'uint40' },{ name: 'id', type: 'uint16' },{ name: 'aTokenAddress', type: 'address' },{ name: 'stableDebtTokenAddress', type: 'address' },{ name: 'variableDebtTokenAddress', type: 'address' },{ name: 'interestRateStrategyAddress', type: 'address' },{ name: 'accruedToTreasury', type: 'uint128' },{ name: 'unbacked', type: 'uint128' },{ name: 'isolationModeTotalDebt', type: 'uint128' }] }] }];
const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] }
];

async function main() {
  console.log('Testing CORRECT Aave V3 Arb Sepolia addresses...\n');
  
  try {
    const reserveData = await client.readContract({ address: POOL, abi: poolAbi, functionName: 'getReserveData', args: [USDC] });
    console.log('Pool.getReserveData SUCCESS');
    console.log('  aToken from pool:', reserveData.aTokenAddress);
    console.log('  Our AUSDC:       ', AUSDC);
    console.log('  Match:', reserveData.aTokenAddress.toLowerCase() === AUSDC.toLowerCase());
  } catch (e) {
    console.log('Pool.getReserveData FAILED:', e.shortMessage || e.message);
  }

  const usdc = await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [USER] });
  const ausdc = await client.readContract({ address: AUSDC, abi: erc20Abi, functionName: 'balanceOf', args: [USER] });
  const allowance = await client.readContract({ address: USDC, abi: erc20Abi, functionName: 'allowance', args: [USER, POOL] });
  
  console.log('\nUser USDC balance:', Number(usdc) / 1e6, 'USDC');
  console.log('User aUSDC balance:', Number(ausdc) / 1e6, 'aUSDC');
  console.log('Current POOL allowance:', Number(allowance) / 1e6, 'USDC');
}
main();
