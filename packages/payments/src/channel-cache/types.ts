import {Allocation, ChannelResult} from '@statechannels/client-api-schema';

import {ChannelSnapshot} from '../types';
export type StalledChannelsOpts = {limit?: number; contextIds?: string[]};

export interface CacheMaintainerAPI {
  // SET
  insertChannels: (allocationId: string, channels: ChannelResult[]) => Promise<string[]>;
  retireChannels: (allocationId: string) => Promise<{amount: string; channelIds: string[]}>;
  removeChannels: (channelIds: string[]) => Promise<void>;
  insertLedgerChannel: (
    allocationId: string,
    channelId: string,

    initialOutcome: Allocation[]
  ) => Promise<void>;
  removeLedgerChannels: (channelIds: string[]) => Promise<void>;

  // GET
  activeAllocations: (allocationIds?: string[]) => Promise<Record<string, number | undefined>>; // at least on active channel
  readyingChannels: (allocationId: string) => Promise<string[]>; // turn_number == 0, not retired
  activeChannels: (allocationId: string) => Promise<string[]>; // not retired
  closableChannels: () => Promise<Record<string, string[]>>;
  stalledChannels: (stallDuration: number, opts: StalledChannelsOpts) => Promise<string[]>;
  getLedgerChannels: (allocationId: string) => Promise<string[]>;
  getInitialLedgerStateInfo: (channelId: string) => Promise<{outcome: Allocation[]}>;
}

export interface CacheUserAPI {
  /*
  1. acquire a lock on an appropriate channel for that allocation.
     While doing so, fetch the current channel "snapshot".
  2. Execute the critical code, which we assume will:
    a. execute some code that's a function of the current snapshot
    b. return the new snapshot
  3. Update the cache with the snapshot returned in (3b)
  4. Commit.
  */
  acquireChannel: <T>(
    allocationId: string,
    criticalCode: (snapshot: ChannelSnapshot) => Promise<{result: T; snapshot: ChannelSnapshot}>
  ) => Promise<T>;

  /*
  1. Assert the turn number in the provided channel result.
     submitReceipt should not be called with a "payment" result
  2. Update the cache with the channel result provided
  */
  submitReceipt: (channel: ChannelResult) => Promise<ChannelSnapshot>;
}
export type CacheUtilitiesAPI = {
  destroy: () => Promise<void>;
  clearCache: () => void;
  initialize: () => Promise<void>;
};
export type ChannelCache = CacheMaintainerAPI & CacheUserAPI & CacheUtilitiesAPI;
