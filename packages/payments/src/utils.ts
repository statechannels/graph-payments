import {fromJS, nullState, toJS, toQueryRequested} from '@graphprotocol/statechannels-contracts';
import {
  makeDestination,
  Uint256,
  makeAddress,
  unreachable,
  NULL_APP_DATA,
  getSignerAddress,
  deserializeState
} from '@statechannels/wallet-core';
import {BigNumber, constants, utils} from 'ethers';
import {Payload as WirePayload} from '@statechannels/wire-format';
import {
  ChannelResult,
  Allocation as ChannelAllocation,
  Participant,
  CreateChannelParams,
  FundingStrategy
} from '@statechannels/client-api-schema';

import {Allocation, ConditionalPayment, Address, toAddress} from './query-engine-types';
import {ChannelQueryResponse, ChannelSnapshot} from './types';
import {EnsureAllocationRequest, ChannelRequest} from './channel-manager';

export function convertBytes32ToAddress(bytes32: string): string {
  const normalized = utils.hexZeroPad(bytes32, 32);
  return utils.getAddress(`0x${normalized.slice(-40)}`);
}

export function constructPaymentUpdate(
  payment: ConditionalPayment,
  channel: ChannelSnapshot
): {allocations: ChannelAllocation[]; appData: string} {
  const {outcome: prevOutcome, appData: prevAppData} = channel;

  const {appData, allocation} = toQueryRequested(
    prevAppData,
    prevOutcome[0],
    payment.amount,
    payment.requestCID,
    payment.allocationId
  );
  return {allocations: [allocation], appData};
}
export const constructStartState = (
  participant: Participant,
  allocation: Allocation,
  fundingStrategy: FundingStrategy,
  assetHolder: Address,
  attestationApp: Address,
  verifyingContract: Address,
  chainId: number,
  amount: Uint256,
  challengeDuration: number
): CreateChannelParams => {
  const {participantId, signingAddress} = participant;
  return {
    /**
     * The amount of time a challenge will wait on chain before finalizing
     */
    challengeDuration,
    /**
     * Where should the money go?
     */
    allocations: [
      {
        assetHolderAddress: makeAddress(assetHolder),
        allocationItems: [
          {
            amount,
            destination: participant.destination
          },
          {amount: '0x0', destination: makeDestination(allocation.id)}
        ]
      }
    ],

    /**
     * How does the app start?
     */
    appDefinition: attestationApp,
    appData: fromJS({
      variable: nullState.variable,
      constants: {
        chainId,
        verifyingContract: verifyingContract.toString(),
        subgraphDeploymentID: allocation.subgraphDeploymentID.bytes32,
        maxAllocationItems: 2
      }
    }),

    /**
     * How is this channel funded?
     */
    fundingStrategy,

    /**
     * Who is in the channel?
     */
    participants: [
      {
        participantId: participantId,
        destination: makeDestination(participant.destination),
        signingAddress: signingAddress
      },
      {
        participantId: allocation.indexer.url,
        destination: makeDestination(allocation.id),
        signingAddress: allocation.indexer.id
      }
    ]
  };
};

// todo(reorg): this should live in statechannels-contracts
export function extractSnapshot(channel: ChannelResult): ChannelSnapshot {
  const {channelId, turnNum, appData, allocations} = channel;
  const {indexerBal, gatewayBal} = extractBalances(channel);
  return {
    channelId,
    turnNum,
    indexerBal,
    gatewayBal,
    appData,
    outcome: allocations as [ChannelAllocation],
    contextId: extractAllocationId(channel)
  };
}

// todo(reorg): this should live in statechannels-contracts
function extractBalances(channelResult: ChannelResult) {
  const {allocations} = channelResult;
  if (allocations.length !== 1) {
    throw new Error(
      `Payment channels should have an outcomes with exactly one allocation. Found ${allocations.length}.`
    );
  }
  const allocation = allocations[0];
  if (!isLedgerChannel(channelResult) && allocation.allocationItems.length !== 2) {
    throw new Error(
      `Payment channels should have an outcome with exactly two allocation items.
      Found ${allocation.allocationItems.length}.`
    );
  }
  const [gatewayItem, indexerItem] = allocation.allocationItems;
  return {
    gatewayBal: BigNumber.from(gatewayItem.amount),
    indexerBal: BigNumber.from(indexerItem?.amount ?? 0)
  };
}

// todo(reorg): this should live in the wire-format package
type ResponseSummary = {
  states?: {channel: string; nonce: number; turnNum: number}[];
  objectives?: {type: string}[];
  requests?: {channel: string; type: string}[];
};

// todo(reorg): this should live in the wire-format package
export function summariseResponse(response: unknown): ResponseSummary {
  const wirePayload = response as WirePayload;
  return {
    states: wirePayload.signedStates?.map((s) => ({
      channel: s.channelId,
      nonce: s.channelNonce,
      turnNum: s.turnNum,
      signedBy: s.signatures.map((sig) => getSignerAddress(deserializeState(s), sig))
    })),
    objectives: wirePayload.objectives?.map((o) => ({type: o.type})),
    requests: wirePayload.requests?.map((r) => ({channel: r.channelId, type: r.type}))
  };
}

// todo(reorg): this should live in statechannels-contracts
export function extractQueryResponse(result: ChannelResult): ChannelQueryResponse {
  const updatedAppData = toJS(result.appData);

  const {subgraphDeploymentID} = updatedAppData.constants;
  const {requestCID, allocationId: indexerAddress} = updatedAppData.variable;
  if (BigNumber.from(updatedAppData.variable.responseCID).eq(0))
    return {
      type: 'query-declined',
      subgraphDeploymentID,
      requestCID,
      indexerAddress
    };
  else {
    const {responseCID, signature} = updatedAppData.variable;
    return {
      type: 'query-accepted',
      responseCID,
      signature,
      subgraphDeploymentID,
      requestCID,
      indexerAddress
    };
  }
}

// TODO: This function should be removed. The allocation id is no longer an attestation channel constant
export function extractAllocationId(channel: ChannelResult): Address {
  return toAddress('0x' + channel.allocations[0].allocationItems[1].destination.slice(26));
}

export function isLedgerChannel(
  channel: Pick<ChannelResult, 'appData' | 'appDefinition'>
): boolean {
  return channel.appDefinition === constants.AddressZero && channel.appData === NULL_APP_DATA;
}

export const delay = async (ms = 10): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const extractCapacity = (
  currentCapacities: Record<string, number | undefined>,
  maxCapacity: number
) => (request: EnsureAllocationRequest): ChannelRequest => {
  const {allocation, type, num} = request;
  if (num <= 0) throw new Error('num must be positive');

  const currentCapacity = currentCapacities[allocation.id] ?? 0;

  let capacity: number;

  switch (type) {
    case 'SetTo':
      if (!Number.isInteger(num)) throw new Error('num must be an integer');
      capacity = Math.max(num, currentCapacity);
      break;
    case 'IncreaseBy':
      if (!Number.isInteger(num)) throw new Error('num must be an integer');
      if (num < 0) throw new Error('adding factor must be positive');
      capacity = currentCapacity + num;
      break;
    case 'ScaleBy':
      // Never scale down!
      if (num < 1) throw new Error('scaling factor must be at least 1');

      // Never scale 0!
      if (currentCapacity === 0) throw new Error('current capacity must be positive');
      capacity = Math.floor(currentCapacity * num);
      break;
    default:
      return unreachable(type);
  }

  capacity = Math.min(capacity, maxCapacity);

  return {allocation, capacity};
};
