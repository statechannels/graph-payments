/* eslint-disable @typescript-eslint/no-explicit-any */
import {ethers, utils, BigNumber} from 'ethers';
import {SubgraphDeploymentID} from '@graphprotocol/common-ts';
import * as base58 from 'bs58';
import {Allocation, ConditionalPayment, toAddress} from '../query-engine-types';

export const LOG_FILE = '/tmp/mock-gateway.log';

export const TEST_SUBGRAPH_ID = new SubgraphDeploymentID(
  base58.encode([
    0x12,
    0x20,
    ...utils.arrayify(utils.sha256(Buffer.from('network-subgraph-indexer-1')))
  ])
);

export const TEST_ALLOCATION: Allocation = {
  id: toAddress('0x2222E21c8019b14dA16235319D34b5Dd83E644A9'),
  indexer: {
    id: toAddress('0x2222E21c8019b14dA16235319D34b5Dd83E644A9'),
    createdAt: Date.parse('2020-05-25'),
    stakedTokens: BigNumber.from(0),
    url: 'http://network-subgraph-indexer-1/'
  },
  subgraphDeploymentID: TEST_SUBGRAPH_ID,
  allocatedTokens: BigNumber.from(0),
  createdAtEpoch: 0
};

export const TEST_PAYMENT: ConditionalPayment = {
  amount: BigNumber.from(1),
  requestCID: ethers.constants.HashZero,
  subgraphDeploymentID: TEST_SUBGRAPH_ID,
  allocationId: TEST_ALLOCATION.id
};

export const buildTestAllocation = (indexerAddress: string, allocationId: string): Allocation => {
  return {
    ...TEST_ALLOCATION,
    id: toAddress(allocationId),
    indexer: {...TEST_ALLOCATION.indexer, id: toAddress(indexerAddress)}
  };
};
