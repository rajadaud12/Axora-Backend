import { Router } from 'express';
import { createPublicClient, http, encodeFunctionData, parseUnits, formatUnits } from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import axios from 'axios';
import {
  getSmartAccountAddress,
  buildUserOperation,
  executeUserOperation,
  bundlerClient,
  bundlerClientSepolia,
} from '../services/aaService';
import type { AaBundlerNetwork } from '../services/aaService';

const router = Router();

const getEnvOrFallback = (key: string, fallback: string) => process.env[key] || fallback;

let cachedPublicClient: any = null;
const getPublicClient = () => {
  if (cachedPublicClient) return cachedPublicClient;
  const rpcUrl = getEnvOrFallback('ALCHEMY_RPC_URL', getEnvOrFallback('ARB_SEPOLIA_RPC_URL', 'https://arbitrum-sepolia.publicnode.com'));
  cachedPublicClient = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(rpcUrl),
  });
  return cachedPublicClient;
};

const getAddresses = () => ({
  USDC: getEnvOrFallback('USDC_ARB_SEPOLIA_ADDRESS', '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d').toLowerCase() as `0x${string}`,
  AUSDC: getEnvOrFallback('AUSDC_ARB_SEPOLIA_ADDRESS', '0x460b97BD498E1157530AEb3086301d5225b91216').toLowerCase() as `0x${string}`,
  POOL: getEnvOrFallback('AAVE_ARB_SEPOLIA_POOL_ADDRESS', '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff').toLowerCase() as `0x${string}`,
});

const USDC_DECIMALS = 6;

const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
];

const poolAbi = [
  {
    type: 'function',
    name: 'supply',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'onBehalfOf', type: 'address' },
      { name: 'referralCode', type: 'uint16' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
];


let cachedApy: number = 6.15;
let lastApyFetch: number = 0;

router.get('/balances/:address', async (req, res) => {
  try {
    const { address } = req.params;

    const smartAccountAddress = await getSmartAccountAddress(address as `0x${string}`);

    const client = getPublicClient();
    const addrs = getAddresses();

    const [eoaSpend, eoaEarn, saSpend, saEarn] = await Promise.all([
      client.readContract({
        address: addrs.USDC,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address as `0x${string}`],
      }) as Promise<bigint>,
      client.readContract({
        address: addrs.AUSDC,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address as `0x${string}`],
      }) as Promise<bigint>,
      client.readContract({
        address: addrs.USDC,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [smartAccountAddress],
      }) as Promise<bigint>,
      client.readContract({
        address: addrs.AUSDC,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [smartAccountAddress],
      }) as Promise<bigint>,
    ]);

    const spendableBigInt = saSpend;
    const earningBigInt = saEarn;

    const now = Date.now();
    if (now - lastApyFetch > 5 * 60 * 1000) {
      try {
        const response = await axios.get('https://yields.llama.fi/chart/7aab7b0f-01c1-4467-bc0d-77826d870f19', { timeout: 3000 });
        if (response.data?.status === 'success' && response.data?.data?.length) {
          const lastPoint = response.data.data[response.data.data.length - 1];
          cachedApy = lastPoint.apy;
          lastApyFetch = now;
        }
      } catch (e) {
        console.error('Failed to fetch APY, using cache', e);
      }
    }

    res.json({
      spendableUsdc: parseFloat(formatUnits(spendableBigInt, USDC_DECIMALS)),
      earningUsdc: parseFloat(formatUnits(earningBigInt, USDC_DECIMALS)),
      aaveApy: cachedApy,
      smartAccountAddress,
    });
  } catch (error) {
    console.error('Balances Error:', error);
    res.status(500).json({ error: 'Failed to fetch balances' });
  }
});

router.get('/transactions/deposit', async (req, res) => {
  try {
    const { user, amount } = req.query;
    if (!user || !amount) return res.status(400).json({ error: 'Missing user or amount' });

    const amountUnits = parseUnits(amount as string, USDC_DECIMALS);
    const userAddress = user as `0x${string}`;

    const addrs = getAddresses();
    const smartAccountAddress = await getSmartAccountAddress(userAddress);

    const approveData = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [addrs.POOL, amountUnits],
    });

    const supplyData = encodeFunctionData({
      abi: poolAbi,
      functionName: 'supply',
      args: [addrs.USDC, amountUnits, smartAccountAddress, 0],
    });

    const calls = [
        { to: addrs.USDC, data: approveData, value: 0n },
        { to: addrs.POOL, data: supplyData, value: 0n },
    ];

    const { userOp, userOpHash } = await buildUserOperation(userAddress, calls);

    const bigIntReplacer = (key: any, value: any) =>
        typeof value === 'bigint' ? value.toString() : value;

    res.json(JSON.parse(JSON.stringify({ userOp, userOpHash, smartAccountAddress }, bigIntReplacer)));
  } catch (error) {
    console.error('Deposit Error:', error);
    res.status(500).json({ error: 'Failed to build deposit tx' });
  }
});

router.get('/transactions/withdraw', async (req, res) => {
  try {
    const { user, amount } = req.query;
    if (!user || !amount) return res.status(400).json({ error: 'Missing user or amount' });

    const amountUnits = parseUnits(amount as string, USDC_DECIMALS);
    const userAddress = user as `0x${string}`;

    const addrs = getAddresses();
    const smartAccountAddress = await getSmartAccountAddress(userAddress);

    const withdrawData = encodeFunctionData({
      abi: poolAbi,
      functionName: 'withdraw',
      args: [addrs.USDC, amountUnits, smartAccountAddress],
    });

    const calls = [
      { to: addrs.POOL, data: withdrawData, value: 0n },
    ];

    const { userOp, userOpHash } = await buildUserOperation(userAddress, calls);

    const bigIntReplacer = (key: any, value: any) =>
        typeof value === 'bigint' ? value.toString() : value;

    res.json(JSON.parse(JSON.stringify({ userOp, userOpHash, smartAccountAddress }, bigIntReplacer)));
  } catch (error) {
    console.error('Withdraw Error:', error);
    res.status(500).json({ error: 'Failed to build withdraw tx' });
  }
});

router.post('/transactions/execute-userop', async (req, res) => {
    try {
        const { userOp, signature, chainId } = req.body;
        if (!userOp || !signature) return res.status(400).json({ error: 'Missing userOp or signature' });

        const network: AaBundlerNetwork =
          chainId === 'eip155:11155111' ? 'sepolia' : 'arbitrumSepolia';
        const hash = await executeUserOperation(userOp, signature, network);
        res.json({ hash });
    } catch (error) {
        console.error('Execute UserOp Error:', error);
        res.status(500).json({ error: 'Failed to execute userOp' });
    }
});

router.get('/transactions/receipt/:hash', async (req, res) => {
  try {
    const { hash } = req.params;
    if (!hash || !hash.startsWith('0x')) return res.status(400).json({ error: 'Invalid hash' });

    const chainId = typeof req.query.chainId === 'string' ? req.query.chainId.trim() : '';
    const bc = chainId === 'eip155:11155111' ? bundlerClientSepolia : bundlerClient;

    try {
      const receipt = await (bc as any).getUserOperationReceipt({ hash: hash as `0x${string}` });
      if (!receipt) {
        return res.json({ mined: false });
      }
      res.json({ mined: true, status: receipt.success });
    } catch (e: any) {
      // Viem usually returns null if not found for bundler endpoints, but catch just in case
      if (e.message?.includes('could not be found') || e.message?.toLowerCase().includes('not found')) {
        return res.json({ mined: false });
      }
      throw e;
    }
  } catch (error) {
    console.error('Fetch Receipt Error:', error);
    res.status(500).json({ error: 'Failed to fetch receipt' });
  }
});

export default router;
