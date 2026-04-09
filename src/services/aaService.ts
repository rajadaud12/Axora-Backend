import { createPublicClient, http, type Chain } from 'viem';
import { arbitrumSepolia, sepolia } from 'viem/chains';
import {
  createSmartAccountClient,
  createBundlerClient,
  ENTRYPOINT_ADDRESS_V06,
} from 'permissionless';
import { signerToSimpleSmartAccount } from 'permissionless/accounts';

const getEnvOrFallback = (key: string, fallback: string) => process.env[key] || fallback;

const ALCHEMY_API_KEY = getEnvOrFallback('ALCHEMY_API_KEY', 'x_x_YOUR_ALCHEMY_KEY_HERE_x_x');

/** Aave / main app flows — Arbitrum Sepolia. */
const alchemyArbSepoliaRpcUrl =
  process.env['ALCHEMY_RPC_URL']?.trim() ||
  `https://arb-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

/** Dinari sandbox (Ethereum Sepolia) — optional dedicated URL. */
const alchemyEthSepoliaRpcUrl =
  process.env['ALCHEMY_SEPOLIA_RPC_URL']?.trim() ||
  process.env['SEPOLIA_RPC_URL']?.trim() ||
  process.env['ETH_SEPOLIA_RPC_URL']?.trim() ||
  `https://eth-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

export type AaBundlerNetwork = 'arbitrumSepolia' | 'sepolia';

const publicClientArb = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(alchemyArbSepoliaRpcUrl),
});

const publicClientSepolia = createPublicClient({
  chain: sepolia,
  transport: http(alchemyEthSepoliaRpcUrl),
});

export const bundlerClient = createBundlerClient({
  chain: arbitrumSepolia,
  transport: http(alchemyArbSepoliaRpcUrl),
  entryPoint: ENTRYPOINT_ADDRESS_V06,
});

/** Bundler client for Ethereum Sepolia (Dinari-linked SCW deploy / txs). */
export const bundlerClientSepolia = createBundlerClient({
  chain: sepolia,
  transport: http(alchemyEthSepoliaRpcUrl),
  entryPoint: ENTRYPOINT_ADDRESS_V06,
});

function getPublicClient(network: AaBundlerNetwork) {
  return network === 'sepolia' ? publicClientSepolia : publicClientArb;
}

function getBundlerClient(network: AaBundlerNetwork) {
  return network === 'sepolia' ? bundlerClientSepolia : bundlerClient;
}

function getRpcUrl(network: AaBundlerNetwork) {
  return network === 'sepolia' ? alchemyEthSepoliaRpcUrl : alchemyArbSepoliaRpcUrl;
}

function getViemChain(network: AaBundlerNetwork): Chain {
  return network === 'sepolia' ? sepolia : arbitrumSepolia;
}

/** CAIP-2 → AA network used for deploy / bundler. */
export function aaNetworkFromCaip2(chainId: string): AaBundlerNetwork {
  return chainId === 'eip155:11155111' ? 'sepolia' : 'arbitrumSepolia';
}

/**
 * Derives the SimpleAccount address for a given EOA owner address deterministically.
 * Uses Arbitrum Sepolia client (same counterfactual address as other chains with same factory).
 */
export const getSmartAccountAddress = async (ownerAddress: `0x${string}`) => {
  const dummySigner = {
    address: ownerAddress,
    signMessage: async () => '0x' as `0x${string}`,
    signTypedData: async () => '0x' as `0x${string}`,
    signTransaction: async () => '0x' as `0x${string}`,
  } as any;

  const simpleAccount = await signerToSimpleSmartAccount(publicClientArb as any, {
    signer: dummySigner,
    factoryAddress: '0x9406Cc6185a346906296840746125a0E44976454',
    entryPoint: ENTRYPOINT_ADDRESS_V06,
  });

  return simpleAccount.address;
};

/** True if the smart account contract is deployed on Arbitrum Sepolia. */
export async function isSmartAccountDeployed(smartAccountAddress: `0x${string}`): Promise<boolean> {
  return isSmartAccountDeployedOnNetwork(smartAccountAddress, 'arbitrumSepolia');
}

/** Bytecode check on the network that matches Dinari `connectInternal` chain. */
export async function isSmartAccountDeployedOnNetwork(
  smartAccountAddress: `0x${string}`,
  network: AaBundlerNetwork,
): Promise<boolean> {
  const code = await getPublicClient(network).getBytecode({ address: smartAccountAddress });
  if (!code || code === '0x') return false;
  const hex = code.replace(/^0x/i, '');
  return hex.length > 0;
}

export async function isSmartAccountDeployedOnChain(
  smartAccountAddress: `0x${string}`,
  caip2ChainId: string,
): Promise<boolean> {
  return isSmartAccountDeployedOnNetwork(smartAccountAddress, aaNetworkFromCaip2(caip2ChainId));
}

/**
 * UserOp that deploys the account (if needed) via a no-op call to the owner.
 * @param network `arbitrumSepolia` — Aave / main; `sepolia` — Dinari sandbox link on Ethereum Sepolia.
 */
export async function buildDeployOnlyUserOperation(
  ownerAddress: `0x${string}`,
  network: AaBundlerNetwork = 'arbitrumSepolia',
) {
  const calls = [{ to: ownerAddress, data: '0x' as `0x${string}`, value: 0n }];
  return buildUserOperation(ownerAddress, calls, network);
}

/**
 * We simulate a SmartAccount Client to build the UserOperation.
 * We intercept the UserOp before it is signed, because our backend cannot sign it
 * (the EOA private key is stored on the Flutter client).
 */
export const buildUserOperation = async (
  ownerAddress: `0x${string}`,
  calls: { to: `0x${string}`; data: `0x${string}`; value: bigint }[],
  network: AaBundlerNetwork = 'arbitrumSepolia',
) => {
  const viemChain = getViemChain(network);
  const rpcUrl = getRpcUrl(network);
  const pc = getPublicClient(network);

  const dummySigner = {
    address: ownerAddress,
    signMessage: async () => '0x' as `0x${string}`,
    signTypedData: async () => '0x' as `0x${string}`,
    signTransaction: async () => '0x' as `0x${string}`,
  } as any;

  const simpleAccount = await signerToSimpleSmartAccount(pc as any, {
    signer: dummySigner,
    factoryAddress: '0x9406Cc6185a346906296840746125a0E44976454',
    entryPoint: ENTRYPOINT_ADDRESS_V06,
  });

  const smartAccountClient = (createSmartAccountClient as any)({
    account: simpleAccount,
    chain: viemChain,
    bundlerTransport: http(rpcUrl),
    middleware: {
      sponsorUserOperation: async ({ userOperation }: any) => {
        const ALCHEMY_GAS_POLICY_ID = process.env.ALCHEMY_GAS_POLICY_ID;

        const response = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'alchemy_requestGasAndPaymasterAndData',
            params: [
              {
                policyId: ALCHEMY_GAS_POLICY_ID,
                entryPoint: ENTRYPOINT_ADDRESS_V06,
                dummySignature:
                  userOperation.signature && userOperation.signature !== '0x'
                    ? userOperation.signature
                    : '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c',
                userOperation: {
                  sender: userOperation.sender,
                  nonce: '0x' + BigInt(userOperation.nonce).toString(16),
                  initCode: userOperation.initCode,
                  callData: userOperation.callData,
                  callGasLimit: '0x0',
                  verificationGasLimit: '0x0',
                  preVerificationGas: '0x0',
                  maxFeePerGas: '0x0',
                  maxPriorityFeePerGas: '0x0',
                },
              },
            ],
          }),
        });

        const data = await response.json();

        if (data.error) {
          console.error('Alchemy Gas Manager Error:', data.error);
          throw new Error(`Gas Sponsorship Failed: ${data.error.message}`);
        }

        return {
          preVerificationGas: data.result.preVerificationGas,
          verificationGasLimit: data.result.verificationGasLimit,
          callGasLimit: data.result.callGasLimit,
          paymasterAndData: data.result.paymasterAndData,
          maxFeePerGas: data.result.maxFeePerGas,
          maxPriorityFeePerGas: data.result.maxPriorityFeePerGas,
        } as any;
      },
    },
  });

  const userOpRequest = await (smartAccountClient as any).prepareUserOperationRequest({
    userOperation: {
      callData: await simpleAccount.encodeCallData(calls.length === 1 ? calls[0] : calls),
    },
  });

  const userOp = userOpRequest as any;

  const { getUserOperationHash } = require('viem/account-abstraction');
  const userOpHash = getUserOperationHash({
    userOperation: userOp,
    chainId: viemChain.id,
    entryPointAddress: ENTRYPOINT_ADDRESS_V06,
    entryPointVersion: '0.6',
  });

  return {
    userOp,
    userOpHash,
    smartAccountAddress: simpleAccount.address,
  };
};

export const executeUserOperation = async (
  userOp: any,
  signature: `0x${string}`,
  network: AaBundlerNetwork = 'arbitrumSepolia',
) => {
  const bc = getBundlerClient(network);
  const formatBigInt = (val: any) => (val ? BigInt(val) : 0n);

  userOp.signature = signature;
  userOp.nonce = formatBigInt(userOp.nonce);
  userOp.callGasLimit = formatBigInt(userOp.callGasLimit);
  userOp.verificationGasLimit = formatBigInt(userOp.verificationGasLimit);
  userOp.preVerificationGas = formatBigInt(userOp.preVerificationGas);
  userOp.maxFeePerGas = formatBigInt(userOp.maxFeePerGas);
  userOp.maxPriorityFeePerGas = formatBigInt(userOp.maxPriorityFeePerGas);

  const hash = await (bc as any).sendUserOperation({
    userOperation: userOp,
  });
  return hash;
};
