import {Logger} from '@graphprotocol/common-ts';
import {BigNumber} from 'ethers';
import {ChannelResult} from '@statechannels/client-api-schema';
import {ChannelCache} from './types';
import {ChannelSnapshot} from '../types';
import {extractSnapshot} from '../utils';
import _ from 'lodash';

interface ChannelRow extends ChannelSnapshot {
  allocationId: string;
  retired: boolean;
  locked: boolean;
  lastChannelUpdateAt: number; // last time the channelSnapshot changed (ignores retired/locked)
}

export class MemoryCache implements ChannelCache {
  private ledgers: Record<string, string> = {};
  private rows: ChannelRow[] = [];
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger && logger.child({component: 'MemoryCache'});
  }

  public async insertLedgerChannel(allocationId: string, channelId: string): Promise<void> {
    this.ledgers[allocationId] = channelId;
  }

  public async removeLedgerChannels(channelIds: string[] = []): Promise<void> {
    for (const allocationId of Object.keys(this.ledgers))
      if (channelIds.includes(this.ledgers[allocationId])) delete this.ledgers[allocationId];
  }

  public async getLedgerChannel(allocationId: string): Promise<string | undefined> {
    return this.ledgers[allocationId];
  }

  // updates or inserts channel
  public async insertChannels(
    // note: allocationId info is included in the channel, but pass in to avoid abi decode
    allocationId: string,
    channels: ChannelResult[]
  ): Promise<void> {
    channels.map((channel) => {
      const snapshot = extractSnapshot(channel);

      const existingIndex = this._findIndex(snapshot.channelId);
      if (existingIndex < 0) {
        this.rows.push({
          ...snapshot,
          allocationId,
          locked: false,
          retired: false,
          lastChannelUpdateAt: Date.now()
        });
      } else {
        throw new Error('Attempting to insert channel multiple times');
      }
    });
  }

  public async removeChannels(channelIds: string[]): Promise<void> {
    await Promise.all(channelIds.map((id) => this.removeChannel(id)));
    return;
  }

  private async removeChannel(channelId: string): Promise<void> {
    const existingIndex = this._findIndex(channelId);
    this.logger?.debug(`Deleting channel ${channelId}`, {
      channel: channelId,
      existingIndex
    });
    if (existingIndex >= 0) {
      this.rows.splice(existingIndex, 1);
    }
  }

  public async activeChannels(allocationId: string): Promise<string[]> {
    return this.rows
      .filter((r) => r.allocationId == allocationId && !r.retired)
      .map((r) => r.channelId);
  }

  public async closableChannels(): Promise<Record<string, string[]>> {
    const grouped = _.groupBy(this.rows.filter(isClosable), (r) => r.allocationId);

    return _.mapValues(grouped, (rows) => rows.map((r) => r.channelId));
  }

  public async activeAllocations(): Promise<Record<string, number>> {
    const result: Record<string, number> = _.mapValues(
      _.groupBy(
        this.rows.filter((row) => !row.retired),
        (row) => row.allocationId
      ),
      (rows) => rows.length
    );

    return result;
  }

  public async stalledChannels(stallDuration = 0): Promise<string[]> {
    return this.rows.filter((r) => isStalled(r, stallDuration)).map((r) => r.channelId);
  }

  // retireChannels for an allocation and return the sum of their indexer balances
  public async retireChannels(
    allocationId: string
  ): Promise<{amount: string; channelIds: string[]}> {
    const rows = this.rows.filter((r) => r.allocationId === allocationId);
    const amount = rows
      .map((r) => r.indexerBal)
      .reduce((a, b) => a.add(b), BigNumber.from('0'))
      .toHexString();
    const channelIds = rows.map((r) => r.channelId);

    rows.map((r) => (r.retired = true));

    return {amount, channelIds};
  }

  public async acquireChannel<T>(
    allocationId: string,
    criticalCode: (snapshot: ChannelSnapshot) => Promise<{result: T; snapshot: ChannelSnapshot}>
  ): Promise<T> {
    this.logger?.debug(`acquire channels ${allocationId}`, {
      rows: this.rows.map((r) => ({
        allocationId: r.allocationId,
        channelId: r.channelId,
        locked: r.locked,
        turnNum: r.turnNum,
        retired: r.retired
      }))
    });

    const index = this.rows.findIndex((r) => r.allocationId === allocationId && isUsable(r));

    if (index < 0) {
      throw new Error(`No free channels for allocation: ${allocationId}`);
    } else {
      const row = this.rows[index];
      this.rows[index] = {...row, locked: true};
      this.logger?.debug(`${row.channelId} locked`);

      const {result, snapshot} = await criticalCode(row);
      this.rows[index] = {
        ...row,
        ...snapshot,
        locked: false,
        lastChannelUpdateAt: Date.now()
      };
      this.logger?.debug(`${row.channelId} unlocked`);
      return result;
    }
  }
  public async submitReceipt(channel: ChannelResult): Promise<ChannelSnapshot> {
    const snapshot = extractSnapshot(channel);
    const channelId = snapshot.channelId;
    const existingIndex = this._findIndex(channelId);
    const existingRow = this.rows[existingIndex];

    if (existingIndex < 0) {
      throw new Error(`Channel not found: ${channelId}`);
    }
    if (existingRow.locked) {
      throw new Error(`Can't update a locked channel: ${channelId}`);
    }

    this.rows[existingIndex] = {
      ...existingRow,
      ...snapshot,
      lastChannelUpdateAt: Date.now()
    };

    return existingRow;
  }

  private _findIndex(channelId: string): number {
    return this.rows.findIndex((row) => row.channelId === channelId);
  }
}
function isOurTurn(row: ChannelRow): boolean {
  return row.turnNum % 2 === 1;
}

function isUsable(row: ChannelRow): boolean {
  // it would probably be nicer to store the status here
  return isOurTurn(row) && !row.locked && !row.retired;
}

function isClosable(row: ChannelRow): boolean {
  return row.retired && !row.locked;
}

function isStalled(row: ChannelRow, stallDuration: number): boolean {
  return !isOurTurn(row) && Date.now() - row.lastChannelUpdateAt >= stallDuration;
}
