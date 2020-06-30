import express from 'express';
import throng from 'throng';
import {Argv, scriptName} from 'yargs';

import {NetworkContracts, createMetrics} from '@graphprotocol/common-ts';
import {
  PostgresCache,
  PaymentManager,
  MemoryCache,
  PaymentManagementAPI,
  ChannelManager,
  ChannelManagementAPI
} from '@graphprotocol/payments';
import _ from 'lodash';
import axios from 'axios';

import bodyParser from 'body-parser';

import {
  RECEIPT_SERVER_URL,
  PAYER_SERVER_PORT,
  TEST_PAYMENT,
  PAYER_SERVER_URL,
  PAYER_PRIVATE_KEY
} from './constants';
import waitOn from 'wait-on';
import cluster from 'cluster';
import {createTestLogger, generateAllocations} from './utils';
import {Logger} from 'pino';
import {constants, Wallet} from 'ethers';
import {BN} from '@statechannels/wallet-core';
import {
  defaultTestConfig,
  overwriteConfigWithDatabaseConnection,
  overwriteConfigWithEnvVars
} from '@statechannels/server-wallet/lib/src/config';

const messageSender = async (indexerUrl: string, payload: unknown, logger: Logger) => {
  const {data} = await axios.post(`${RECEIPT_SERVER_URL}/messages`, payload);
  logger.trace('Received data from message endpoint', data);
  return data;
};

const mockContracts = {
  assetHolder: {address: process.env.ETH_ASSET_HOLDER_ADDRESS || constants.AddressZero}, // TODO: Replace with GRTAssetHolder contract
  attestationApp: {address: process.env.ATTESTATION_APP || constants.AddressZero},
  staking: {collect: _.noop},
  disputeManager: {address: constants.AddressZero}
} as NetworkContracts;

const createPayment = async (
  allocationId: string,
  paymentManager: PaymentManagementAPI,
  logger: Logger
): Promise<unknown> => {
  let payment;
  try {
    payment = await paymentManager.createPayment(allocationId, TEST_PAYMENT);
  } catch (err) {
    logger.debug(`No channels found. Payment failed.`, {
      allocationId,
      err
    });
    return;
  }
  return payment;
};

const metrics = createMetrics();

const builder = (yargs: Argv): Argv =>
  yargs
    .option('logFile', {type: 'string', required: true})
    .alias('l', 'logFile')
    .option('fundsPerAllocation', {type: 'number', default: BN.from(10 ** 12)})
    .option('paymentChannelFundingAmount', {type: 'string', default: BN.from(10 ** 10)})
    .option('channelsPerAllocation', {type: 'number', default: 2})
    .alias('c', 'channelsPerAllocation')
    .option('pgUsername', {type: 'string', default: 'postgres'})
    .alias('u', 'pgUsername')
    .option('pgDatabase', {type: 'string', default: 'payer'})
    .alias('d', 'pgDatabase')
    .option('ensureAllocations', {type: 'boolean', default: true})
    .alias('e', 'ensureAllocations')
    .option('useDatabase', {type: 'boolean', default: true})
    .option('useLedger', {type: 'boolean', default: false})
    .option('fundingStrategy', {type: 'string', default: 'Fake'})
    .alias('f', 'fundingStrategy')
    .boolean('cluster');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyArgs = {[key: string]: any} & Argv['argv'];

const createTasks = (logger: Logger) => ({
  waitForReceiptServer: async () => {
    logger.info('Waiting for receipt server to start');
    // Wait for the receipt server to be up and running
    await waitOn({resources: [RECEIPT_SERVER_URL]});
  },
  ensureAllocations: async ({
    paymentChannelFundingAmount,
    channelsPerAllocation,
    fundsPerAllocation,
    useDatabase,
    useLedger,
    fundingStrategy,
    numAllocations = 1,
    pgDatabase
  }: AnyArgs) => {
    const channelManager = await ChannelManager.create({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: logger.child({module: 'PaymentManager'}) as any,
      messageSender: (i, p) => messageSender(i, p, logger),
      fundsPerAllocation,
      paymentChannelFundingAmount,
      contracts: mockContracts,
      metrics,
      cache: useDatabase ? PostgresCache : new MemoryCache(),
      fundingStrategy,
      destinationAddress: new Wallet(PAYER_PRIVATE_KEY).address,
      useLedger,
      syncOpeningChannelsPollIntervalMS: 2500,

      walletConfig: {
        ...overwriteConfigWithDatabaseConnection(
          // TODO: Currently the env vars get set for the deployed contracts so we still load them
          // This should be cleaned up when we remove all env vars
          overwriteConfigWithEnvVars(defaultTestConfig),
          {dbName: pgDatabase}
        ),
        networkConfiguration: {
          ...defaultTestConfig.networkConfiguration,
          rpcEndpoint: process.env.RPC_ENDPOINT
        }
      }
    });
    await channelManager.prepareDB();

    const testAllocations = generateAllocations(numAllocations);

    logger.info('Setting up channels for allocations', {
      allocationIds: testAllocations.map((x) => x.id)
    });
    await channelManager.ensureAllocations(
      testAllocations.map((allocation) => ({allocation, num: channelsPerAllocation, type: 'SetTo'}))
    );

    return channelManager;
  }
});

const commands = {
  listen: {
    command: 'listen',
    describe:
      'Start a payment manager, optionally call `ensureAllocations`, and start listening to the `/sendPayment` endpoint',
    builder,
    handler: async (args: AnyArgs): Promise<void> => {
      const {ensureAllocations, logFile} = args;
      const logger = createTestLogger(logFile).child({module: 'PaymentServer'});
      logger.level = 'debug';
      const tasks = createTasks(logger);
      await tasks.waitForReceiptServer();
      let channelManager: ChannelManagementAPI;

      if (ensureAllocations && cluster.isMaster) {
        channelManager = await tasks.ensureAllocations(args);
      }

      const paymentManager = await PaymentManager.create({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logger: logger.child({module: 'PaymentManager'}) as any,
        metrics,
        cache: PostgresCache,
        walletConfig: overwriteConfigWithDatabaseConnection(defaultTestConfig, {
          dbName: args.pgDatabase
        })
      });

      const start = () => startApp(channelManager, paymentManager, logger);

      args.cluster
        ? throng({
            start,
            // We only use half of the cores, assuming that the remainder will be used for the receiver server.
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            workers: (() => require('os').cpus().length / 2)()
          })
        : start();
    }
  }
};

scriptName('payer')
  .command(commands.listen)
  .demandCommand(1, 'Choose a command from the above list')
  .help().argv;

function startApp(
  channelManager: ChannelManagementAPI,
  paymentManager: PaymentManagementAPI,
  logger: Logger
) {
  const app = express();
  app
    .use(bodyParser.json({limit: '5mb'}))
    .get('/', (_, res) => res.status(200).send('Ready to roll!'))
    .get('/sendPayment', async (req, res) => {
      const privateKey = req.query.privateKey as string;
      const allocationId = req.query.allocationId as string;

      const payment = await createPayment(allocationId, paymentManager, logger);

      if (!payment)
        // 406 is Not Acceptable
        return res.status(406).send('Payment failed: no channel available');

      if (req.query.expectPaymentNotReceived) {
        res.status(500).send('Payment failed: receiver was unreachable');
      } else {
        const {data} = await axios.post(`${RECEIPT_SERVER_URL}/payment`, {
          payment,
          allocationId,
          privateKey
        });

        if (req.query.expectReceiptNotReceived) {
          res.status(500).send('Payment failed: receiver never responded');
        } else {
          const result = await paymentManager.submitReceipt(data);

          logger.debug('SendPayment result', result);

          res.send(result);
        }
      }
    })
    .get('/syncChannels', async (_req, res) => {
      try {
        await channelManager.syncChannels(0);
        res.status(200).send(true);
      } catch (err) {
        logger.error({err}, 'syncChannels failed');
        res.status(500).send(`syncChannels failed with ${err.message}`);
      }
    })
    .get('/syncAllocations', async (_req, res) => {
      try {
        await channelManager.syncAllocations([]);
        res.send();
      } catch (err) {
        logger.error({err}, `syncAllocations failed ${err.message}`);
        res.status(500).send(`syncAllocations failed with ${err.message}`);
      }
    })
    .listen(PAYER_SERVER_PORT, () => {
      logger.info(`Listening for requests`, {url: PAYER_SERVER_URL});
    });
}
