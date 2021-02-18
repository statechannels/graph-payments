/* eslint-disable @typescript-eslint/no-explicit-any */
import express from 'express';
import joi from 'joi';
import throng from 'throng';
import {Argv, scriptName} from 'yargs';
import {NetworkContracts, createMetrics, Logger} from '@graphprotocol/common-ts';
import {
  createPostgresCache,
  PaymentManager,
  PaymentManagementAPI,
  ChannelManager,
  ChannelManagementAPI
} from '@graphprotocol/payments';
import _ from 'lodash';
import axios from 'axios';
import bodyParser from 'body-parser';
import waitOn from 'wait-on';
import {BigNumber, constants, Wallet} from 'ethers';
import {BN} from '@statechannels/wallet-core';
import {
  defaultTestConfig,
  overwriteConfigWithDatabaseConnection
} from '@statechannels/server-wallet';
import {Address} from '@graphprotocol/statechannels-contracts';
import {ETHERLIME_ACCOUNTS} from '@statechannels/devtools';

import {createTestLogger, generateAllocations} from './utils';
import {
  RECEIPT_SERVER_URL,
  PAYER_SERVER_PORT,
  PAYER_SERVER_URL,
  PAYER_PRIVATE_KEY,
  REQUEST_CID,
  TEST_SUBGRAPH_ID,
  TEST_ATTESTATION_APP_ADDRESS
} from './constants';

type MessageSenderConfig = {
  dropOutgoingRate: number;
  dropIncomingRate: number;
  meanDelay: number;
  logger: Logger;
};

const constructMessageSender = (config: MessageSenderConfig) => {
  const {logger, dropIncomingRate, dropOutgoingRate, meanDelay} = config;

  return async (_indexerUrl: string, payload: unknown) => {
    if (Math.random() <= dropOutgoingRate) {
      logger.warn('Dropping outgoing message', {payload});
      return;
    }

    const {data} = await axios.post(`${RECEIPT_SERVER_URL}/messages`, payload);
    logger.trace('Received data from message endpoint', data);

    if (Math.random() <= dropIncomingRate) {
      logger.warn('Dropping incoming message', {data});
      return;
    }

    if (meanDelay) {
      // Serves two purposes:
      // 1. randomly re-order messages
      // 2. introduce latency to better represent real-world usage, where the payer & receiver
      //    are not co-located
      await new Promise((r) => setTimeout(r, meanDelay / 2 + Math.random() * meanDelay));
    }
    return data;
  };
};

const mockContracts = {
  assetHolder: {address: process.env.ETH_ASSET_HOLDER_ADDRESS || constants.AddressZero}, // TODO: Replace with GRTAssetHolder contract
  attestationApp: {
    address: process.env.ATTESTATION_APP || TEST_ATTESTATION_APP_ADDRESS
  },
  staking: {collect: _.noop},
  disputeManager: {address: constants.AddressZero}
} as NetworkContracts;

const createPayment = async (
  allocationId: Address,
  paymentManager: PaymentManagementAPI,
  logger: Logger
): Promise<unknown> => {
  let payment;
  try {
    payment = await paymentManager.createPayment({
      allocationId,
      amount: BigNumber.from(1),
      requestCID: REQUEST_CID,
      subgraphDeploymentID: TEST_SUBGRAPH_ID
    });
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
    .option('numAllocations', {type: 'number', default: 0})
    .alias('c', 'channelsPerAllocation')
    .option('pgUsername', {type: 'string', default: 'postgres'})
    .alias('u', 'pgUsername')
    .option('pgDatabase', {type: 'string', default: 'payer'})
    .alias('d', 'pgDatabase')
    .option('useDatabase', {type: 'boolean', default: true})
    .option('useLedger', {type: 'boolean', default: false})
    .option('fundingStrategy', {type: 'string', default: 'Fake'})
    .alias('f', 'fundingStrategy')
    .option('amountOfWorkerThreads', {type: 'number', default: 0})
    .option('dropOutgoingRate', {type: 'number', default: 0})
    .option('dropIncomingRate', {type: 'number', default: 0})
    .option('meanDelay', {type: 'number', default: 0})
    .boolean('cluster');

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
    useLedger,
    fundingStrategy,
    numAllocations,
    pgDatabase,
    amountOfWorkerThreads,
    messageSenderConfig,
    logFile
  }: AnyArgs & {messageSenderConfig: MessageSenderConfig}) => {
    const messageSender = constructMessageSender(messageSenderConfig);

    const channelManager = await ChannelManager.create({
      logger: logger.child({module: 'PaymentManager'}) as any,
      messageSender,
      fundsPerAllocation,
      paymentChannelFundingAmount,
      contracts: mockContracts,
      metrics,
      fundingStrategy,
      destinationAddress: new Wallet(PAYER_PRIVATE_KEY).address,
      useLedger,
      syncOpeningChannelsPollIntervalMS: 2500,
      ensureAllocationsConcurrency: 10,

      walletConfig: defaultTestConfig({
        workerThreadAmount: Number(amountOfWorkerThreads),
        databaseConfiguration: {connection: {database: pgDatabase}},
        chainServiceConfiguration: {
          attachChainService: !!process.env.RPC_ENDPOINT,
          provider: process.env.RPC_ENDPOINT,
          pk: ETHERLIME_ACCOUNTS[0].privateKey
        },
        loggingConfiguration: {
          logDestination: logFile,
          logLevel: 'trace'
        }
      }),
      backoffStrategy: {
        numAttempts: 1,
        initialDelay: 50
      }
    });

    const testAllocations = generateAllocations(numAllocations);

    logger.info('Setting up channels for allocations', {
      allocationIds: testAllocations.map((x) => x.id)
    });

    await channelManager.ensureAllocations(
      testAllocations.map((allocation) => ({allocation, num: channelsPerAllocation, type: 'SetTo'}))
    );

    logger.info('Channels set up', {
      allocationIds: testAllocations.map((x) => x.id)
    });

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
      const {logFile, dropIncomingRate, dropOutgoingRate, meanDelay} = args;
      const logger = createTestLogger(logFile).child({module: 'PaymentServer'});
      (logger as any).level = 'trace';

      logger.info('starting payment server', {args});
      const tasks = createTasks(logger);
      await tasks.waitForReceiptServer();

      const messageSenderConfig: MessageSenderConfig = {
        meanDelay,
        dropIncomingRate,
        dropOutgoingRate,
        logger
      };
      const channelManager = await tasks.ensureAllocations({...args, messageSenderConfig});

      const paymentManager = await PaymentManager.create({
        logger: logger.child({module: 'PaymentManager'}),
        metrics,
        cache: createPostgresCache({
          database: args.pgDatabase,
          user: args.pgUsername,
          host: 'localhost'
        }),
        walletConfig: overwriteConfigWithDatabaseConnection(defaultTestConfig(), {
          database: args.pgDatabase,
          user: args.pgUsername,
          host: 'localhost'
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
      const allocationId = req.query.allocationId as Address;

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
        logger.error('syncChannels failed', {err});
        res.status(500).send(`syncChannels failed with ${err.message}`);
      }
    });

  const requests = joi.array().items(
    joi.object({
      allocation: joi
        .object({
          id: joi.string().required(),
          indexer: joi
            .object({
              url: joi.string().required(),
              id: joi.string().required(),
              stakedTokens: joi.object().required(),
              createdAt: joi.number().optional()
            })
            .required(),
          subgraphDeploymentID: joi
            .object({
              display: joi.object().optional(),
              ipfsHash: joi.string().optional(),
              bytes32: joi.string().required(),
              value: joi.string().required(),
              kind: joi.equal('deployment-id')
            })
            .required(),
          allocatedTokens: joi.object().required(),
          createdAtEpoch: joi.number().required()
        })
        .required(),
      type: joi.string().required(),
      num: joi.number().required()
    })
  );

  const schema = joi.object({requests});

  app
    .post('/syncAllocations', async (req, res) => {
      try {
        const {error, value} = schema.validate(req.body);
        if (error) {
          logger.error('invalid data', {error});
          res.status(500).send({message: 'syncAllocations failed', error});
          return;
        }

        await channelManager.syncAllocations(value.requests ?? []);
        res.send('Allocations synced');
      } catch (err) {
        logger.error(`syncAllocations failed ${err.message}`, {err});
        res.status(500).send({err, message: 'syncAllocations failed'});
      }
    })
    .listen(PAYER_SERVER_PORT, () => {
      logger.info(`Listening for requests`, {url: PAYER_SERVER_URL});
    });
}
