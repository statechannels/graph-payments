/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'fs';

import axios, {AxiosResponse} from 'axios';
import _ from 'lodash';
import {Wallet as ChannelWallet} from '@statechannels/server-wallet';
import {ChannelResult} from '@statechannels/client-api-schema';
import {providers, Contract} from 'ethers';
import {ContractArtifacts} from '@statechannels/nitro-protocol';
import {BN, NULL_APP_DATA} from '@statechannels/wallet-core';
import {Logger} from '@graphprotocol/common-ts';
import {EnsureAllocationRequest} from '@graphprotocol/payments/src/channel-manager';

import {createTestLogger, generateAllocationIdAndKeys} from '../src/utils';

export function setupLogging(logFilePath: string): Logger {
  logFilePath && fs.existsSync(logFilePath) && fs.truncateSync(logFilePath);
  const logger = createTestLogger(logFilePath);
  (logger as any).level = 'debug';
  return logger;
}

export function mineNBlocks(provider: providers.JsonRpcProvider, n: number) {
  return (): void => _.range(n).forEach(() => provider?.send('evm_mine', []));
}

export function makeEthAssetHolderContract(
  provider: providers.JsonRpcProvider,
  ethAssetHolderAddress: string
): Contract {
  return new Contract(
    ethAssetHolderAddress,
    ContractArtifacts.EthAssetHolderArtifact.abi,
    provider
  );
}

export const getChannels = async (wallet: ChannelWallet): Promise<ChannelResult[]> =>
  (await wallet.getChannels()).channelResults.filter((c) => c.appData !== NULL_APP_DATA);

// We know the destination of the second allocationItem will be the allocationId
export const getChannelsForAllocations = (
  channels: ChannelResult[],
  allocationId: string
): ChannelResult[] =>
  channels.filter(({allocations}) =>
    BN.eq(allocationId, allocations[0].allocationItems[1].destination)
  );

export const successfulPayment = (
  payerServerUrl: string,
  params?: {
    privateKey?: string;
    allocationId?: string;
    expectPaymentNotReceived?: boolean;
    expectReceiptNotReceived?: boolean;
  }
): Promise<AxiosResponse<{status: number}>> => {
  const defaultParams = generateAllocationIdAndKeys(1)[0];
  return axios.get(`${payerServerUrl}/sendPayment`, {params: _.merge(defaultParams, params)});
};

export const syncChannels = (payerServerUrl: string): Promise<{status: number}> =>
  axios.get(`${payerServerUrl}/syncChannels`);

export const syncAllocations = (
  payerServerUrl: string,
  params?: {
    requests: EnsureAllocationRequest[];
  }
): Promise<{status: number}> => axios.post(`${payerServerUrl}/syncAllocations`, params);
