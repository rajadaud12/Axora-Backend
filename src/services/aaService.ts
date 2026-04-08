import { createPublicClient, http, encodeFunctionData, parseEther } from 'viem';
import { arbitrumSepolia } from 'viem/chains';
import {
  createSmartAccountClient,
  createBundlerClient,
  ENTRYPOINT_ADDRESS_V06,
} from 'permissionless';
import { signerToSimpleSmartAccount } from 'permissionless/accounts';

const getEnvOrFallback = (key: string, fallback: string) => process.env[key] || fallback;

// Using a fallback Alchemy Key if none provided
const ALCHEMY_API_KEY = getEnvOrFallback('ALCHEMY_API_KEY', 'x_x_YOUR_ALCHEMY_KEY_HERE_x_x');

// Alchemy Bundler and Node RPC
const alchemyRpcUrl = `https://arb-sepolia.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;

// We use permissionless.js to create the simple smart account
const publicClient = createPublicClient({
  chain: arbitrumSepolia,
  transport: http(alchemyRpcUrl),

});

export const bundlerClient = createBundlerClient({
  chain: arbitrumSepolia,
  transport: http(alchemyRpcUrl),
  entryPoint: ENTRYPOINT_ADDRESS_V06,
});

/**
 * Derives the SimpleAccount address for a given EOA owner address deterministically.
 */
export const getSmartAccountAddress = async (ownerAddress: `0x${string}`) => {
  const dummySigner = {
    address: ownerAddress,
    signMessage: async () => '0x' as `0x${string}`,
    signTypedData: async () => '0x' as `0x${string}`,
    signTransaction: async () => '0x' as `0x${string}`,
  } as any;

  const simpleAccount = await signerToSimpleSmartAccount(publicClient as any, {
    signer: dummySigner,
    factoryAddress: '0x9406Cc6185a346906296840746125a0E44976454', // v0.6 factory
    entryPoint: ENTRYPOINT_ADDRESS_V06,
  });

  return simpleAccount.address;
};

/**
 * We simulate a SmartAccount Client to build the UserOperation.
 * We intercept the UserOp before it is signed, because our backend cannot sign it 
 * (the EOA private key is stored on the Flutter client).
 */
export const buildUserOperation = async (
  ownerAddress: `0x${string}`,
  calls: { to: `0x${string}`, data: `0x${string}`, value: bigint }[]
) => {
  const dummySigner = {
    address: ownerAddress,
    signMessage: async () => '0x' as `0x${string}`,
    signTypedData: async () => '0x' as `0x${string}`,
    signTransaction: async () => '0x' as `0x${string}`,
  } as any;

  const simpleAccount = await signerToSimpleSmartAccount(publicClient as any, {
    signer: dummySigner,
    factoryAddress: '0x9406Cc6185a346906296840746125a0E44976454',
    entryPoint: ENTRYPOINT_ADDRESS_V06,
  });

  const smartAccountClient = (createSmartAccountClient as any)({
    account: simpleAccount,
    chain: arbitrumSepolia,
    bundlerTransport: http(alchemyRpcUrl),
    middleware: {
      sponsorUserOperation: async ({ userOperation }: any) => {
        const ALCHEMY_GAS_POLICY_ID = process.env.ALCHEMY_GAS_POLICY_ID;

        const response = await fetch(alchemyRpcUrl, {
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
                dummySignature: userOperation.signature && userOperation.signature !== '0x'
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
                  maxPriorityFeePerGas: '0x0'
                }
              }
            ]
          })
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
      }
    }
  });

  const userOpRequest = await (smartAccountClient as any).prepareUserOperationRequest({
    userOperation: {
      callData: await simpleAccount.encodeCallData(
        calls.length === 1 ? calls[0] : calls
      ),
    }
  });

  const userOp = userOpRequest as any;

  // We use standard viem format for hashing
  const { getUserOperationHash } = require('viem/account-abstraction');
  const userOpHash = getUserOperationHash({
    userOperation: userOp,
    chainId: arbitrumSepolia.id,
    entryPointAddress: ENTRYPOINT_ADDRESS_V06,
    entryPointVersion: '0.6'
  });

  return {
    userOp,
    userOpHash,
    smartAccountAddress: simpleAccount.address,
  };
};

export const executeUserOperation = async (userOp: any, signature: `0x${string}`) => {
  // Rehydrate fields that were stringified via JSON to BigInts for viem
  const formatBigInt = (val: any) => val ? BigInt(val) : 0n;

  userOp.signature = signature;
  userOp.nonce = formatBigInt(userOp.nonce);
  userOp.callGasLimit = formatBigInt(userOp.callGasLimit);
  userOp.verificationGasLimit = formatBigInt(userOp.verificationGasLimit);
  userOp.preVerificationGas = formatBigInt(userOp.preVerificationGas);
  userOp.maxFeePerGas = formatBigInt(userOp.maxFeePerGas);
  userOp.maxPriorityFeePerGas = formatBigInt(userOp.maxPriorityFeePerGas);

  const hash = await (bundlerClient as any).sendUserOperation({
    userOperation: userOp,
  });
  return hash;
};
