import {Allocation, ChannelResult} from '@statechannels/client-api-schema';
import {BigNumber} from 'ethers';
import createPGP, {IDatabase, IMain, ITask, PreparedStatement} from 'pg-promise';
import _ from 'lodash';

import {ChannelSnapshot} from '../types';
import {TABLE} from '../db/constants';
import {extractSnapshot} from '../utils';
import {createKnex, migrateCacheDB} from '../db/utils';
import {DatabaseConnectionConfiguration} from '..';

import {
  CacheMaintainerAPI,
  CacheUserAPI,
  CacheUtilitiesAPI,
  ChannelCache,
  StalledChannelsOpts
} from './types';

type Row = {
  context_id: string;
  app_data: string;
  channel_id: string;
  receiver_balance: string;
  payer_balance: string;
  turn_number: number;
  outcome: [Allocation];
};

type LedgerRow = {
  channel_id: string;
  context_id: string;
  initial_outcome: [Allocation];
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

const channelResultToRow = (cr: ChannelResult) => ({
  app_data: cr.appData,
  channel_id: cr.channelId,
  turn_number: cr.turnNum,
  outcome: JSON.stringify(cr.allocations)
});

function createChannelManagement(pgp: IMain, db: IDatabase<unknown>): CacheMaintainerAPI {
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

  return {
    getInitialLedgerStateInfo: async (channelId) => {
      const query = pgp.as.format(
        'SELECT initial_outcome FROM payment_manager.ledger_channels WHERE channel_id = ${channelId}',
        {channelId}
      );
      const result: LedgerRow = await db.one(query);
      const {initial_outcome: outcome} = result;
      return {outcome};
    },
    insertLedgerChannel: async (allocationId, channelId, initialOutcome): Promise<void> => {
      const row = {
        channel_id: channelId,
        context_id: allocationId,
        initial_outcome: JSON.stringify(initialOutcome)
      };
      const columns = new pgp.helpers.ColumnSet(['channel_id', 'context_id', 'initial_outcome'], {
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

    getLedgerChannels: async (allocationId: string): Promise<string[]> => {
      const query = pgp.as.format(
        'SELECT channel_id FROM payment_manager.ledger_channels WHERE context_id = ${allocationId}',
        {allocationId}
      );
      const result = await db.manyOrNone(query);
      return result.map((r) => r.channel_id);
    },

    /**
     *
     * @param allocationId context_id stored in the DB
     * @param channels list of channels to insert
     *
     * Inserts each channel into the DB.
     *
     * In the event of a conflict on the `channel_id`, sets the turn_number to 3.
     * This signals to payment managers that the channel is "ready to be used"
     */
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

      const query = `\
      ${pgp.helpers.insert(rows, insertColumns)} 
      ON CONFLICT (channel_id) DO UPDATE
      SET turn_number = excluded.turn_number
      WHERE payment_channels.turn_number = 0
      AND excluded.turn_number = 3
      RETURNING channel_id
      `;

      return (await db.manyOrNone(query)).map((row) => row.channel_id);
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

    readyingChannels: async (contextId: string) => {
      const query = `
      SELECT channel_id FROM ${TABLE} 
      WHERE ${NOT_RETIRED}
      AND turn_number = 0
      AND ${pgp.as.format('context_id = $1', contextId)}
      `;

      return db.manyOrNone(query).then((rows) => rows.map((row) => row.channel_id));
    },

    stalledChannels: async (stallDurationMS: number, opts: StalledChannelsOpts) => {
      const {limit, contextIds} = opts;
      let query = `
      SELECT channel_id FROM ${TABLE}
      WHERE ${NOT_OUR_TURN}
      AND ${NOT_RETIRED}
      AND updated_at <= now() - interval '${stallDurationMS} milliseconds'
    `;
      // We assume that we were passed limit != 0, since limit === 0 does not make sense
      // In case some channels are permanently stalled, we order by random().
      if (contextIds) query = `${query} AND context_id = any(${pgp.as.array(contextIds)})`;
      if (typeof limit === 'number') query = `${query} ORDER BY random() LIMIT ${limit}`;

      const rows = await db.manyOrNone(query);
      return rows.map((row) => row.channel_id);
    }
  };
}
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

export function createPaymentManagement(pgp: IMain, db: IDatabase<unknown>): CacheUserAPI {
  return {
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
}

function createCacheUtilities(
  pgp: IMain,
  db: IDatabase<unknown>,
  databaseConnection: DatabaseConnectionConfiguration
): CacheUtilitiesAPI {
  return {
    initialize: async () => {
      const knex = createKnex(databaseConnection);
      await migrateCacheDB(knex);
      knex.destroy();
    },
    destroy: async () => pgp.end(),
    clearCache: () =>
      Promise.all([
        db.none('TRUNCATE payment_manager.payment_channels'),
        db.none('TRUNCATE payment_manager.ledger_channels')
      ])
  };
}

export function createPostgresCache(
  databaseConnection: DatabaseConnectionConfiguration
): ChannelCache {
  const pgp = createPGP();
  const db = pgp(databaseConnection);
  return {
    ...createChannelManagement(pgp, db),
    ...createPaymentManagement(pgp, db),
    ...createCacheUtilities(pgp, db, databaseConnection)
  };
}

class CacheError extends Error {
  constructor(reason: string, public readonly allocationId: string) {
    super(reason);
  }
}
