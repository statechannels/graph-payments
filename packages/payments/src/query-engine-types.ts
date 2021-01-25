import {BigNumber, utils} from 'ethers';
import {SubgraphDeploymentID, Attestation} from '@graphprotocol/common-ts';

export type Address = string & {_isAddress: void};

export const toAddress = (s: Address | string): Address => utils.getAddress(s) as Address;

export interface ConditionalPayment {
  amount: BigNumber;
  requestCID: string;
  subgraphDeploymentID: SubgraphDeploymentID;
  allocationId: Address;
}

export interface QueryExecutionResult {
  graphQLResponse: string;
  attestation: Attestation;
}

export interface Indexer {
  id: Address;
  createdAt?: number;
  url: string;
  stakedTokens: BigNumber;
}

export interface Allocation {
  id: Address;
  indexer: Indexer;
  subgraphDeploymentID: SubgraphDeploymentID;
  allocatedTokens: BigNumber;
  createdAtEpoch: number;
}
