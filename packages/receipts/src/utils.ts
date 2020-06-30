import {Payload as WirePayload} from '@statechannels/wire-format';
import {ChannelResult, ChannelStatus} from '@statechannels/client-api-schema';
import {BigNumber, constants} from 'ethers';

type PayloadSummary = {
  states?: {channel: string; nonce: number; turnNum: number}[];
  objectives?: {type: string}[];
  requests?: {channel: string; type: string}[];
};

// todo(reorg): this should really be in the wire-format package
export function summarisePayload(payload: unknown): PayloadSummary {
  const wirePayload = payload as WirePayload;
  return {
    states: wirePayload.signedStates?.map((s) => ({
      channel: s.channelId,
      nonce: s.channelNonce,
      turnNum: s.turnNum
    })),
    objectives: wirePayload.objectives?.map((o) => ({
      type: o.type,
      ...o.data
    })),
    requests: wirePayload.requests?.map((r) => ({channel: r.channelId, type: r.type}))
  };
}

// todo(reorg): this should live in statechannels-contracts
export interface ChannelSnapshot {
  channelId: string;
  turnNum: number;
  gatewayBal: string;
  indexerBal: string;
  status: ChannelStatus;
}

// todo(reorg): this should live in statechannels-contracts
export function extractSnapshot(channel: ChannelResult): ChannelSnapshot {
  const {channelId, turnNum, status} = channel;
  const {indexerBal, gatewayBal} = extractBalances(channel);
  return {channelId, turnNum, status, indexerBal, gatewayBal};
}

// todo(reorg): this should live in statechannels-contracts
function extractBalances(channelResult: ChannelResult) {
  const {allocations} = channelResult;
  if (allocations.length !== 1) {
    throw new Error(
      `Payment channels should have an outcome with exactly one allocation. Found ${allocations.length}.`
    );
  }
  const allocation = allocations[0];
  if (!isLedgerChannel(channelResult) && allocation.allocationItems.length !== 2) {
    throw new Error(
      `Payment channels should have an outcom with exactly two allocation items.
      Found ${allocation.allocationItems.length}.`
    );
  }
  const [gatewayItem, indexerItem] = allocation.allocationItems;
  return {
    gatewayBal: BigNumber.from(gatewayItem.amount).toHexString(),
    indexerBal: BigNumber.from(indexerItem?.amount ?? 0).toHexString()
  };
}

export function isLedgerChannel(
  channel: Pick<ChannelResult, 'appData' | 'appDefinition'>
): boolean {
  return channel.appDefinition === constants.AddressZero && channel.appData === '0x00';
}
