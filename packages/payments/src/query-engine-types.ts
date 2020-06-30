import {BigNumber, utils} from 'ethers';
import {SubgraphDeploymentID, Attestation} from '@graphprotocol/common-ts';

export type Address = string & {_isAddress: void};

export const toAddress = (s: Address | string): Address =>
  typeof s === 'string' ? (utils.getAddress(s) as Address) : s;

export interface ConditionalPayment {
  amount: BigNumber;
  requestCID: string;
  subgraphDeploymentID: SubgraphDeploymentID;
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
