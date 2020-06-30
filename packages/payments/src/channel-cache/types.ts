import {ChannelResult} from '@statechannels/client-api-schema';
import {ChannelSnapshot} from '../types';

export interface CacheMaintainerAPI {
  // SET
  insertChannels: (allocationId: string, channels: ChannelResult[]) => Promise<void>;
  retireChannels: (allocationId: string) => Promise<{amount: string; channelIds: string[]}>;
  removeChannels: (channelIds: string[]) => Promise<void>;
  insertLedgerChannel: (allocationId: string, channelId: string) => Promise<void>;
  removeLedgerChannels: (channelIds: string[]) => Promise<void>;

  // GET
  activeAllocations: (allocationIds?: string[]) => Promise<Record<string, number | undefined>>; // at least on active channel
  activeChannels: (allocationId: string) => Promise<string[]>; // not retired
  closableChannels: () => Promise<Record<string, string[]>>;
  stalledChannels: (stallDuration: number, limit?: number) => Promise<string[]>;
  getLedgerChannel: (allocationId: string) => Promise<string | undefined>;
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

export type ChannelCache = CacheMaintainerAPI & CacheUserAPI;
