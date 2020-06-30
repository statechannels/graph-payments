import {ChannelCache, CacheMaintainerAPI, CacheUserAPI} from './types';

import {Allocation, ChannelResult} from '@statechannels/client-api-schema';
import {BigNumber} from 'ethers';
import {ChannelSnapshot} from '../types';

import {CONNECTION_STRING, TABLE} from '../db/constants';
import {extractSnapshot} from '../utils';
import createPGP, {IDatabase, ITask, PreparedStatement} from 'pg-promise';
import _ from 'lodash';

const pgp = createPGP();
const db = pgp(CONNECTION_STRING);

let destroyed = false;
export const destroy = (): void => {
  if (!destroyed) db.$pool.end();
  destroyed = true;
};

type Row = {
  context_id: string;
  app_data: string;
  channel_id: string;
  receiver_balance: string;
  payer_balance: string;
  turn_number: number;
  outcome: [Allocation];
};

const OUR_TURN = 'turn_number % 2 = 1';
const NOT_OUR_TURN = 'turn_number % 2 = 0';
const NOT_RETIRED = 'retired = false';
const RETIRED = 'retired = true';

const updateCacheQuery = new PreparedStatement({
  name: 'UpdateCache',
  text: `
    UPDATE ${TABLE}
    SET
      turn_number = $1,
      app_data = $2,
      payer_balance = $3,
      receiver_balance = $4,
      outcome = $5,
      updated_at = now()
    WHERE channel_id = $6 AND ${NOT_RETIRED}
  `
});

const updateCache = async (
  snapshot: ChannelSnapshot,
  dbOrTx: ITask<unknown> | IDatabase<unknown>
) => {
  await dbOrTx.none(updateCacheQuery, [
    snapshot.turnNum,
    snapshot.appData,
    snapshot.gatewayBal.toHexString(),
    snapshot.indexerBal.toHexString(),
    JSON.stringify(snapshot.outcome),
    snapshot.channelId
  ]);
};

function convertRowToSnapshot(row: Row): ChannelSnapshot {
  return {
    appData: row.app_data,
    channelId: row.channel_id,
    turnNum: row.turn_number,
    gatewayBal: BigNumber.from(row.payer_balance),
    indexerBal: BigNumber.from(row.receiver_balance),
    outcome: row.outcome,
    contextId: row.context_id
  };
}

const table = {table: 'payment_channels', schema: 'payment_manager'};

const insertColumns = new pgp.helpers.ColumnSet(
  [
    'app_data',
    'channel_id',
    'context_id',
    'payer_balance',
    'receiver_balance',
    'turn_number',
    'outcome'
  ],
  {table}
);

const retiredColumns = new pgp.helpers.ColumnSet(['retired'], {table});

const channelResultToRow = (cr: ChannelResult) => ({
  app_data: cr.appData,
  channel_id: cr.channelId,
  turn_number: cr.turnNum,
  outcome: JSON.stringify(cr.allocations)
});

export const ChannelManagement: CacheMaintainerAPI = {
  insertLedgerChannel: async (allocationId: string, channelId: string): Promise<void> => {
    const row = {channel_id: channelId, context_id: allocationId};
    const columns = new pgp.helpers.ColumnSet(['channel_id', 'context_id'], {
      table: {table: 'ledger_channels', schema: 'payment_manager'}
    });
    await db.none(pgp.helpers.insert(row, columns));
  },

  removeLedgerChannels: async (channelIds: string[]): Promise<void> => {
    if (channelIds.length === 0) return;
    await db.none(
      `DELETE FROM payment_manager.ledger_channels WHERE channel_id in ($1)`,
      channelIds
    );
  },

  getLedgerChannel: async (allocationId: string): Promise<string | undefined> => {
    const query = pgp.as.format(
      'SELECT channel_id FROM payment_manager.ledger_channels WHERE context_id = ${allocationId}',
      {allocationId}
    );
    const result = await db.oneOrNone(query);
    return result?.channel_id;
  },

  insertChannels: async (allocationId: string, channels: ChannelResult[]) => {
    const rows = channels.map((channelResult) => {
      const [payer_balance, receiver_balance] = channelResult.allocations[0].allocationItems.map(
        (allocationItem) => allocationItem.amount
      );

      return {
        ...channelResultToRow(channelResult),
        context_id: allocationId,
        payer_balance,
        receiver_balance
      };
    });

    await db.none(pgp.helpers.insert(rows, insertColumns));
  },

  removeChannels: async (channelIds: string[]) => {
    if (channelIds.length > 0) {
      const query = `
        DELETE FROM ${TABLE}
        WHERE channel_id = any(${pgp.as.array(channelIds)})
      `;
      await db.none(query);
    }
  },

  retireChannels: async (allocationId: string) => {
    const query = `
      ${pgp.helpers.update({retired: true}, retiredColumns)}
      WHERE ${pgp.as.format('context_id = ${allocationId}', {allocationId})}
      AND ${NOT_RETIRED}
      RETURNING receiver_balance, channel_id
    `;
    const rows = await db.manyOrNone(query);
    const amount = rows
      .map((row) => BigNumber.from(row.receiver_balance))
      .reduce((sum, amt) => sum.add(amt), BigNumber.from(0))
      .toHexString();

    const channelIds = rows.map((row) => row.channel_id);

    return {amount, channelIds};
  },

  activeAllocations: async (allocationIds?: string[]) => {
    let query = `SELECT context_id, count(*) FROM ${TABLE} WHERE NOT ${RETIRED}`;
    if (allocationIds) query = `${query} AND context_id = any(${pgp.as.array(allocationIds)})`;

    query = `${query} GROUP BY context_id`;
    return _.reduce(
      await db.manyOrNone(query),
      (result, row) => {
        result[row.context_id] = Number(row.count);
        return result;
      },
      {} as Record<string, number>
    );
  },

  activeChannels: async (allocationId: string) => {
    const query = `
      SELECT channel_id FROM ${TABLE} 
      WHERE ${NOT_RETIRED}
      AND ${pgp.as.format('context_id = $1', allocationId)}
    `;
    const rows = await db.manyOrNone(query);
    return rows.map((row) => row.channel_id);
  },

  closableChannels: async () => {
    const query = `
      SELECT channel_id, context_id FROM ${TABLE} 
      WHERE ${RETIRED}
    `;
    const rows = await db.manyOrNone(query);
    const grouped = _.groupBy(rows, (r) => r.context_id);

    return _.mapValues(grouped, (rows) => rows.map((r) => r.channel_id));
  },

  stalledChannels: async (stallDurationMS: number, limit?: number) => {
    let query = `
      SELECT channel_id FROM ${TABLE}
      WHERE ${NOT_OUR_TURN}
      AND ${NOT_RETIRED}
      AND updated_at <= now() - interval '${stallDurationMS} milliseconds'
    `;
    // We assume that we were passed limit != 0, since limit === 0 does not make sense
    // In case some channels are permanently stalled, we order by random().
    if (limit) query = `${query} ORDER BY random() LIMIT ${limit}`;
    const rows = await db.manyOrNone(query);
    return rows.map((row) => row.channel_id);
  }
};

const acquireChannel = new PreparedStatement({
  name: 'AcquireChannel',
  text: `
    SELECT * FROM ${TABLE}
    WHERE context_id = $1
    AND ${OUR_TURN} AND ${NOT_RETIRED}
    LIMIT 1 
    FOR UPDATE
    SKIP LOCKED;
  `
});

export const PaymentManagement: CacheUserAPI = {
  acquireChannel: async <T>(
    allocationId: string,
    criticalCode: (snapshot: ChannelSnapshot) => Promise<{snapshot: ChannelSnapshot; result: T}>
  ) => {
    return await db.tx(async (tx) => {
      const row = await tx.oneOrNone(acquireChannel, [allocationId]);

      if (!row) {
        throw new CacheError('No free channels found', allocationId);
      }

      const {snapshot, result} = await criticalCode(convertRowToSnapshot(row));

      await updateCache(snapshot, tx);

      return result;
    });
  },

  submitReceipt: async (channel) => {
    const ourTurn = channel.turnNum % 2 === 1;
    if (!ourTurn && channel.turnNum !== 0) {
      throw new Error(`Cannot submit receipt on our turn: ${channel.turnNum}`);
    }
    const snapshot = extractSnapshot(channel);
    await updateCache(snapshot, db);
    return snapshot;
  }
};

export const PostgresCache: ChannelCache = {...PaymentManagement, ...ChannelManagement};

class CacheError extends Error {
  constructor(reason: string, public readonly allocationId: string) {
    super(reason);
  }
}
