import {Address} from '@graphprotocol/common-ts';
import {Allocation} from '@statechannels/client-api-schema';
import {BigNumber} from 'ethers';

interface QueryAccepted {
  type: 'query-accepted';
  requestCID: string;
  responseCID: string;
  subgraphDeploymentID: string;
  indexerAddress: Address;
  signature: string;
}

interface QueryDeclined {
  type: 'query-declined';
  requestCID: string;
  indexerAddress: Address;
  subgraphDeploymentID: string;
}

export type ChannelQueryResponse = QueryAccepted | QueryDeclined;

export interface ChannelSnapshot {
  channelId: string;
  turnNum: number;
  gatewayBal: BigNumber;
  indexerBal: BigNumber;
  outcome: [Allocation];
  appData: string;
  contextId: string;
}
