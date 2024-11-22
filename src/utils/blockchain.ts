/**
 * Copyright 2024 Circle Internet Group, Inc.  All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { ethers, toBigInt } from "ethers";
import { createBundlerClient, ENTRYPOINT_ADDRESS_V07, estimateUserOperationGas, getAccountNonce, UserOperation } from "permissionless";
import { concat, concatHex, createPublicClient, encodeFunctionData, hexToBigInt, http, pad, toHex } from "viem";
import { readContract } from "viem/actions";

import { EntryPointABI, ERC20ABI } from "../abi/index.js";
import { ViemChain } from "./configs.js";
import { isAlchemyBundler, maxBigInt } from "./helpers.js";
import logger, { formatUserOperation, logAndExit } from "./logger.js";
import { Address, ERC20TransferParams, GetPartialUserOpParams, MultiSigParams, MultiSigUserOpParams, Signer, UserOpEstimateParams, UserOpParams } from "./types.js";

export const getUserOpHash = async (
  { chain, bundlerRPCUrl, userOp }: UserOpParams,
  entryPoint: `0x${string}`
): Promise<`0x${string}`> => {
  let initCode = toHex("");
  if (userOp.factory && userOp.factoryData) {
    initCode = concatHex([userOp.factory, userOp.factoryData]);
  }

  const accountGasLimits = concatHex([
    pad(toHex(userOp.verificationGasLimit), { size: 16 }),
    pad(toHex(userOp.callGasLimit), { size: 16 }),
  ]);
  
  const gasFees = concatHex([
    pad(toHex(userOp.maxPriorityFeePerGas), { size: 16 }),
    pad(toHex(userOp.maxFeePerGas), { size: 16 }),
  ]);

  const packedUserOp = {
    sender: userOp.sender,
    nonce: userOp.nonce,
    callData: userOp.callData,
    accountGasLimits,
    initCode,
    preVerificationGas: userOp.preVerificationGas,
    gasFees,
    paymasterAndData: "0x",
    signature: userOp.signature,
  };

  const client = createBundlerClient({
    chain: ViemChain[chain],
    transport: http(bundlerRPCUrl),
    entryPoint: ENTRYPOINT_ADDRESS_V07,
  });

  const partialUserOpHash = await readContract(client, {
    address: entryPoint,
    abi: EntryPointABI,
    functionName: "getUserOpHash",
    args: [packedUserOp],
  });

  logger.debug(`partialUserOpHash: ${partialUserOpHash}`);
  return partialUserOpHash as `0x${string}`;
};

export const signUserOp = async ({
  chain,
  bundlerRPCUrl,
  signer,
  userOp,
}: UserOpParams & { signer: Signer }): Promise<string> => {
  const partialUserOpHash = await getUserOpHash(
    { chain, bundlerRPCUrl, userOp },
    ENTRYPOINT_ADDRESS_V07
  );

  let signature: string;

  const ethersWallet = new ethers.Wallet(signer.privateKey, undefined);
  signature = await ethersWallet.signMessage(
    ethers.getBytes(partialUserOpHash)
  );

  logger.debug(`signature: ${signature}`);
  return signature;
};

export const getPartialUserOp = async ({
  chain,
  bundlerRPCUrl,
  senderAddress,
  callData,
}: GetPartialUserOpParams): Promise<UserOperation<"v0.7">> => {
  const client = createBundlerClient({
    chain: ViemChain[chain],
    transport: http(bundlerRPCUrl),
    entryPoint: ENTRYPOINT_ADDRESS_V07,
  });

  const userOp: UserOperation<"v0.7"> = {
    sender: senderAddress,
    nonce: await getAccountNonce(client, {
      entryPoint: ENTRYPOINT_ADDRESS_V07,
      sender: senderAddress,
    }),
    callData: callData,
    maxPriorityFeePerGas: toBigInt(0),
    maxFeePerGas: toBigInt(0),
    callGasLimit: toBigInt(0),
    verificationGasLimit: toBigInt(0),
    preVerificationGas: toBigInt(0),
    signature: '0x'
  }

  if (userOp.nonce === toBigInt(0)) {
    logAndExit('Can only generate user-ops for deployed wallets (nonce > 0)')
  }

  logger.debug(`partialUserOp: ${formatUserOperation(userOp)}`);
  return userOp;
}

export const estimateUserOp = async ({
  chain,
  bundlerRPCUrl,
  userOp,
  numSigners,
  gasFeesMultiplier,
}: UserOpEstimateParams): Promise<UserOperation<"v0.7">> => {

  const client = createBundlerClient({
    chain: ViemChain[chain],
    transport: http(bundlerRPCUrl),
    entryPoint: ENTRYPOINT_ADDRESS_V07,
  });

  const publicClient = createPublicClient({
    chain: ViemChain[chain],
    transport: http(bundlerRPCUrl),
  });
  
  const feesPerGas = await publicClient.estimateFeesPerGas();

  if (!feesPerGas.maxFeePerGas || !feesPerGas.maxPriorityFeePerGas) {
    logAndExit(`Error estimating fees per gas`)
  }

  if (gasFeesMultiplier < 1) {
    logAndExit(`Gas fees multiplier must be >= 1 (provided: ${gasFeesMultiplier})`)
  }

  let alchemyMaxPriorityFeePerGas = BigInt(0);
  if (isAlchemyBundler(bundlerRPCUrl)) {
    const alchemyOptions = {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        method: 'rundler_maxPriorityFeePerGas'
      })
    };

    const alchemyResponse = await fetch(bundlerRPCUrl, alchemyOptions)
      .then(res => res.json())
      .catch(err => {
        logger.error('Error fetching from Alchemy:', err);
        throw err; // Rethrow error for further handling if desired
      });

    const alchemyHexResult = alchemyResponse.result;

    // Convert hex result to Wei
    alchemyMaxPriorityFeePerGas = alchemyHexResult ? BigInt(alchemyHexResult) : BigInt(0);
    logger.debug('Alchemy max priority fee per gas (in Wei):', alchemyMaxPriorityFeePerGas.toString());
  }

  const percentageIncrease = Math.round((gasFeesMultiplier - 1) * 100);
  const scaledGasFeesMultiplier = 100 + percentageIncrease;
  const adjustedMaxFeePerGas = feesPerGas.maxFeePerGas! * BigInt(scaledGasFeesMultiplier) / BigInt(100);
  const adjustedMaxPriorityFeePerGasBeforeMin = feesPerGas.maxPriorityFeePerGas! * BigInt(scaledGasFeesMultiplier) / BigInt(100);
  const adjustedMaxPriorityFeePerGas = maxBigInt(adjustedMaxPriorityFeePerGasBeforeMin, alchemyMaxPriorityFeePerGas)

  logger.debug(`Original max fee per gas (in Wei): ${feesPerGas.maxFeePerGas}`);
  logger.debug(`Adjusted max fee per gas (in Wei): ${adjustedMaxFeePerGas}`);
  
  logger.debug(`Original max priority fee per gas (in Wei): ${feesPerGas.maxPriorityFeePerGas}`);
  logger.debug(`Adjusted max priority fee per gas (in Wei): ${adjustedMaxPriorityFeePerGas}`);

  const partialUserOpForEstimate: UserOperation<"v0.7"> = {
    sender: userOp.sender,
    nonce: userOp.nonce,
    factory: userOp.factory,
    factoryData: userOp.factoryData,
    callData: userOp.callData,
    maxPriorityFeePerGas: adjustedMaxPriorityFeePerGas,
    maxFeePerGas: adjustedMaxFeePerGas,
    // Signature needs to include num of signers to get accurate gas estimates
    // Otherwise when broadcasting, you might end up with 'precheck failed: preVerificationGas is 45768 but must be at least 46680'
    signature: '0x' + 'fffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3c'.repeat(numSigners) as `0x${string}`,
    callGasLimit: toBigInt(0),
    verificationGasLimit: toBigInt(0),
    preVerificationGas: toBigInt(0)
  };

  const gasLimits = await estimateUserOperationGas(client, {
    entryPoint: ENTRYPOINT_ADDRESS_V07,
    userOperation: partialUserOpForEstimate
  });

  const callGasLimit = gasLimits.callGasLimit;
  const verificationGasLimit = gasLimits.verificationGasLimit;
  const preVerificationGas = gasLimits.preVerificationGas;

  const partialUserOpWithGas: UserOperation<"v0.7"> = {
    ...partialUserOpForEstimate,
    callGasLimit,
    verificationGasLimit,
    preVerificationGas,
    signature: '0x',
  };

  logger.debug(`partialUserOpWithGas: ${formatUserOperation(partialUserOpWithGas)}`);
  return partialUserOpWithGas;
}

export const buildAndSignMultisigUserOp = async ({
  chain,
  bundlerRPCUrl,
  walletAddress,
  signerAddresses,
  gasFeesMultiplier,
  callData,
}: MultiSigParams): Promise<UserOperation<"v0.7">> => {
  const signatures: Array<{ signer: Address; signature: string; userOpSigType?: string }> = [];

  const partialUserOp = await getPartialUserOp({
    chain,
    bundlerRPCUrl,
    senderAddress: walletAddress,
    callData,
  });

  const numSigners = signerAddresses.length;

  let partialUserOpWithGas = partialUserOp;

  // Sign using the specified logic based on the number of signers
  for (let i = 0; i < numSigners; i++) {
    const signer = signerAddresses[i];
    const isLastSigner = i === numSigners - 1;

    // If it's the last signer, use partialUserOpWithGas
    const userOpToSign = isLastSigner
      ? await estimateUserOp({
          chain,
          bundlerRPCUrl,
          userOp: partialUserOp,
          numSigners: numSigners,
          gasFeesMultiplier,
        })
      : partialUserOp;

    // Will be updated w/ gas during processing of last signer
    partialUserOpWithGas = userOpToSign;

    logger.debug(`Sign with ${signer.address}`);
    const signature = await signUserOp({
      chain,
      bundlerRPCUrl,
      signer, // Assuming this gets the signer instance
      userOp: userOpToSign,
    });
    signatures.push({ signer: signer.address, signature, userOpSigType: isLastSigner ? "ACTUAL" : undefined });
  }

  // Build the multi-signature user operation
  const multiSigUserOp = await buildMultiSigUserOp({
    userOp: partialUserOpWithGas,
    signatures,
  });

  return multiSigUserOp;
};

export const buildMultiSigUserOp = async ({
  userOp,
  signatures,
}: MultiSigUserOpParams): Promise<UserOperation<"v0.7">> => {
  const multiSigUserOp = { ...userOp };

  // Signature packing logic from aa-sdk
  const takeBytes = (bytes: string, { offset, count }: { offset?: number; count?: number }) => {
    const start = (offset ? offset * 2 : 0) + 2; // add 2 to skip the 0x prefix
    const end = count ? start + count * 2 : undefined;

    return `0x${bytes.slice(start, end)}`;
  };

  let eoaSigs = "";
  signatures
    .sort((a, b) => {
      const bigintA = hexToBigInt(a.signer);
      const bigintB = hexToBigInt(b.signer);

      return bigintA < bigintB ? -1 : bigintA > bigintB ? 1 : 0;
    })
    .forEach((sig) => {
      // add 32 to v if the signature covers the actual gas values
      const addV = sig.userOpSigType === "ACTUAL" ? 32 : 0;

      let v = parseInt(takeBytes(sig.signature, { count: 1, offset: 64 })) + addV;

      logger.debug(`address: ${sig.signer} v: ${v}`);

      eoaSigs += concat([
        takeBytes(sig.signature, { count: 64 }) as `0x${string}`,
        toHex(v, { size: 1 }),
      ]).slice(2);
    });
    
  const finalUserOp: UserOperation<"v0.7"> = {
    ...multiSigUserOp,
    signature: "0x" + eoaSigs as `0x${string}`
  };

  logger.debug(`multiSigUserOp: ${formatUserOperation(finalUserOp)}`);
  return finalUserOp;
};

export const getERC20TransferCallData = ({ toAddress, amount }: ERC20TransferParams) => {
  return encodeFunctionData({
    abi: ERC20ABI,
    functionName: "transfer",
    args: [toAddress, amount],
  });
};

export const encodeCallData = (args: any): string => {
  if (Array.isArray(args)) {
    return encodeFunctionData({
      abi: [{
        inputs: [
          { internalType: "address[]", name: "dest", type: "address[]" },
          { internalType: "uint256[]", name: "value", type: "uint256[]" },
          { internalType: "bytes[]", name: "func", type: "bytes[]" },
        ],
        name: "executeBatch",
        outputs: [],
        stateMutability: "nonpayable",
        type: "function",
      }],
      functionName: "executeBatch",
      args: [
        args.map((a: any) => a.to),
        args.map((a: any) => a.value),
        args.map((a: any) => a.data),
      ],
    });
  }

  const { to, value, data } = args;
  return encodeFunctionData({
    abi: [{
      inputs: [
        { internalType: "address", name: "dest", type: "address" },
        { internalType: "uint256", name: "value", type: "uint256" },
        { internalType: "bytes", name: "func", type: "bytes" },
      ],
      name: "execute",
      outputs: [],
      stateMutability: "nonpayable",
      type: "function",
    }],
    functionName: "execute",
    args: [to, value, data],
  });
};