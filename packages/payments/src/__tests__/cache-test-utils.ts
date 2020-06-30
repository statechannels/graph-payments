import {Argv, scriptName} from 'yargs';

import {ethers} from 'ethers';
import _ from 'lodash';
import {ChannelManagement, PaymentManagement} from '../channel-cache/postgres-cache';
import {ChannelResult} from '@statechannels/client-api-schema';
import {ChannelSnapshot} from '../types';
import {knex} from '../knexfile';
import {TABLE} from '../db/constants';
import {delay} from '../utils';

const channelCache = knex.table(TABLE);
async function acquireAndHold(contextId: string, id: number): Promise<void> {
  // Add a random delay so that two successive calls have a non-deterministic outcome.
  // Useful for testing concurrent calls to acquirePaymentChannel
  await delay(_.random(0, 10));

  console.log(`${id}: acquiring`);
  await PaymentManagement.acquireChannel(contextId, async (snapshot) => {
    console.log(`${id}: acquired`);

    await delay();

    console.log(`${id}: releasing`);

    return {snapshot, result: undefined};
  });
}

const channelResult = (input?: Partial<ChannelResult>): ChannelResult => ({
  turnNum: input?.turnNum ?? 3,
  channelId: input?.channelId ?? ethers.Wallet.createRandom().address,
  status: 'running',
  appData: '',
  appDefinition: '',
  participants: [],
  allocations: [
    {
      assetHolderAddress: '',
      allocationItems: [
        {amount: '5', destination: 'alice'},
        {amount: '10', destination: 'bob'}
      ]
    }
  ]
});

/*
By using this util, you can observe the connection holding a lock until this process exits.
eg `SELECT * FROM pg_locks;`


This shows that managers that ask for a channel and then crash, don't lock the channel.
*/
const acquireAndDisconnect = {
  command: 'acquireAndDisconnect',
  describe: 'acquires a channel, but does not release it',
  builder: (yargs: Argv): Argv => yargs.option('timeout', {type: 'number', default: 0, alias: 't'}),
  handler: async ({timeout}: {timeout: number}) => {
    const context = 'uniqueContext';
    await channelCache.delete().where({context_id: context});

    await ChannelManagement.insertChannels(context, [channelResult()]);

    await PaymentManagement.acquireChannel(context, async ({channelId}) => {
      console.log(
        `acquired ${channelId} from process ${process.pid}. Waiting ${timeout} seconds before exiting`
      );

      await delay(timeout * 1_000);

      console.log('exiting');
      process.exit();
    });
  }
};

const testSaturatedContext = {
  command: 'testSaturatedContext',
  describe:
    'Ensures exactly one payer for a given context, and asks for that payer twice, serially.',
  handler: async () => {
    const newInsert = ethers.Wallet.createRandom().address;
    const context = 'uniqueContext';
    await channelCache.delete().where({context_id: context});

    await ChannelManagement.insertChannels(context, [channelResult({turnNum: 5})]);

    let id = 0;
    const channelId = await acquireAndHold(context, (id += 1));
    await acquireAndHold(context, (id += 1)).catch((reason) =>
      console.log(`Expected to fail; failed with ${reason}`)
    );

    console.log(`got ${channelId} for a unique context. Expected ${newInsert}`);

    process.exit();
  }
};

const testConcurrentRequests = {
  command: 'testConcurrentRequests',
  describe:
    'Ensures exactly one payer for a given context, and asks for that payer twice, concurrently.',
  handler: async () => {
    const context = 'uniqueContext';
    await channelCache.delete().where({context_id: context});

    await ChannelManagement.insertChannels(context, [channelResult({turnNum: 5})]);

    const p1 = acquireAndHold(context, 1).catch(() => console.log(`request 1 failed`));
    const p2 = acquireAndHold(context, 2).catch(() => console.log(`request 2 failed`));

    await Promise.all([p1, p2]).catch(console.error);

    process.exit();
  }
};

const lockedChannels = {
  command: 'getLocked',
  describe: 'show the locked channel ids',
  handler: async () => {
    const lockedChannels = await ChannelManagement.stalledChannels();

    console.log(`locked channels: ${lockedChannels}`);

    process.exit();
  }
};

const seed = {
  command: 'seed',
  describe: 'seed some data in the payer cache',
  builder: (yargs: Argv): Argv =>
    yargs
      .option('numContexts', {type: 'number', default: 10})
      .alias('c', 'numContexts')
      .option('numEntries', {type: 'number', default: 100})
      .alias('e', 'numEntries'),
  handler: async ({
    numEntries,
    numContexts
  }: {
    numEntries: number;
    numContexts: number;
  }): Promise<void> => {
    console.log(`Creating ${numEntries} entries with ${numContexts} contexts`);

    const rows = _.range(numEntries).map((i) => ({
      channel_id: `channel-${i}-${_.random(12345678910111213.1).toString()}`,
      context_id: `context-${_.random(0, numContexts)}`,
      turn_number: 3,
      payer_balance: '100',
      receiver_balance: '100',
      app_data: ''
    }));

    // If I try to insert more than 20k rows at once, it seems to crash.
    // So, insert them in chunks of 20_000
    for (const chunk of _.chunk(rows, 20_000)) {
      console.log(`${numEntries} remaining. inserting ${chunk.length} rows`);
      await channelCache.insert(chunk);
      numEntries -= chunk.length;
    }

    process.exit();
  }
};

const doNothing = async (snapshot: ChannelSnapshot) => ({snapshot, result: undefined});

const benchmark = {
  command: 'benchmark',
  describe: 'Run a simple benchmark',
  builder: (yargs: Argv): Argv =>
    yargs.option('numChannels', {type: 'number', default: 1_000}).alias('c', 'numChannels'),
  handler: async ({numChannels}: {numChannels: number}): Promise<void> => {
    console.log('benchmarking');
    // warm up the connection pool and the DB cache
    // await Promise.all(
    //   _.range(200).map(async () => {
    //     console.log('acquiring')
    //     const {release, channelId} = await PaymentManagement.acquireChannel('context-1')
    //     console.log('releasing')
    //     await release(channelResult({channelId}))
    //   }),
    // )

    console.time(`acquire channel x ${numChannels}`);
    await Promise.all(
      _.range(numChannels).map(async () => {
        await PaymentManagement.acquireChannel('context-1', doNothing);
      })
    );
    console.timeEnd(`acquire channel x ${numChannels}`);

    process.exit();
  }
};

const commands = {
  seed,
  benchmark,
  lockedChannels,
  testSaturatedContext,
  testConcurrentRequests,
  acquireAndDisconnect
};

scriptName('payer-cache-test')
  // .command(commands.seed)
  // .command(commands.benchmark)
  .command(commands.lockedChannels)
  .command(commands.testSaturatedContext)
  .command(commands.testConcurrentRequests)
  // .command(commands.acquireAndDisconnect)
  .demandCommand(1, 'Choose a command from the above list')
  .help().argv;
