import {Allocation as Insights} from '@statechannels/client-api-schema';
import {ConditionalPayment} from './query-engine-types';
import {ChannelSnapshot} from './types';

type SingleChannelEvent = {
  channelId: string;
  turnNum: number;
  outcome: Insights;
  contextId: string;
};
type InternalChannelEvent<T> = {type: T; channels: SingleChannelEvent[]};

// Channel management
export type ChannelsCreated = InternalChannelEvent<'ChannelsCreated'>;
export type ChannelsReady = InternalChannelEvent<'ChannelsReady'>;
export type ChannelsSynced = InternalChannelEvent<'ChannelsSynced'>;
export type ChannelsRetired = {
  type: 'ChannelsRetired';
  report: {[allocationId: string]: {allocationId: string; amount: string; channelIds: string[]}};
};
export type ChannelsClosed = {type: 'ChannelsClosed'; channelIds: string[]};
export type ChannelManagerInsightEvent =
  | ChannelsCreated
  | ChannelsReady
  | ChannelsSynced
  | ChannelsRetired
  | ChannelsClosed;

export const isChannelsCreated = (e: ChannelManagerInsightEvent): e is ChannelsCreated =>
  e.type === 'ChannelsCreated';
export const isChannelsReady = (e: ChannelManagerInsightEvent): e is ChannelsReady =>
  e.type === 'ChannelsReady';
export const isChannelsSynced = (e: ChannelManagerInsightEvent): e is ChannelsSynced =>
  e.type === 'ChannelsSynced';
export const isChannelsRetired = (e: ChannelManagerInsightEvent): e is ChannelsRetired =>
  e.type === 'ChannelsRetired';
export const isChannelsClosed = (e: ChannelManagerInsightEvent): e is ChannelsClosed =>
  e.type === 'ChannelsClosed';

export function snapshotToSingleChannelEvent(cs: ChannelSnapshot): SingleChannelEvent {
  const {
    channelId,
    turnNum,
    outcome: [outcome]
  } = cs;
  return {channelId, turnNum, outcome, contextId: cs.contextId};
}
export function channelEvent(
  type: 'ChannelsCreated' | 'ChannelsReady' | 'ChannelsSynced',
  snapshots: ChannelSnapshot[]
): ChannelManagerInsightEvent {
  const channels = snapshots.map(snapshotToSingleChannelEvent);
  return {type, channels};
}

// Payment manager
export type ReceiptSubmittedEvent = {
  type: 'ReceiptSubmitted';
  allocation: string;
  channel: SingleChannelEvent;
};
export type PaymentCreatedEvent = {
  type: 'PaymentCreated';
  allocation: string;
  payment: ConditionalPayment;
  channel: SingleChannelEvent;
};
export type PaymentFailedEvent = {
  type: 'PaymentFailed';
  allocation: string;
  err: Error;
};
export type PaymentManagerInsightEvent =
  | ReceiptSubmittedEvent
  | PaymentCreatedEvent
  | PaymentFailedEvent;

export const isPaymentCreated = (e: PaymentManagerInsightEvent): e is PaymentCreatedEvent =>
  e.type === 'PaymentCreated';
export const isPaymentFailed = (e: PaymentManagerInsightEvent): e is PaymentFailedEvent =>
  e.type === 'PaymentFailed';
export const isReceiptSubmitted = (e: PaymentManagerInsightEvent): e is ReceiptSubmittedEvent =>
  e.type === 'ReceiptSubmitted';
