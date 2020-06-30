import express from 'express';
import pino from 'pino';

import bodyParser from 'body-parser';
import {ReceiptManager} from '@graphprotocol/receipts';
import {RECEIPT_PRIVATE_KEY, RECEIPT_SERVER_PORT, RECEIPT_SERVER_URL} from './constants';
import {Argv, scriptName} from 'yargs';
import throng from 'throng';
import {createTestLogger, generateAttestations} from './utils';
import {
  defaultTestConfig,
  overwriteConfigWithDatabaseConnection
} from '@statechannels/server-wallet/lib/src/config';
import {ETHERLIME_ACCOUNTS} from '@statechannels/devtools';
import {constants} from 'ethers';
import {NetworkContracts} from '@graphprotocol/common-ts';

const builder = (yargs: Argv): Argv =>
  yargs
    .option('ensureAllocations', {type: 'boolean', default: true})
    .alias('e', 'ensureAllocations')
    .option('port', {type: 'number', default: RECEIPT_SERVER_PORT})
    .alias('p', 'port')
    .boolean('cluster')
    .option('logFile', {type: 'string', required: true})
    .alias('l', 'logFile')
    .option('numAllocations', {type: 'number', default: 1});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyArgs = {[key: string]: any} & Argv['argv'];

const commands = {
  listen: {
    command: 'listen',
    describe: 'Start a receipt manager, and start listening to the `/sendPayment` endpoint',
    builder,
    handler: async (args: AnyArgs): Promise<void> => {
      const logger = createTestLogger(args.logFile).child({module: 'ReceiptServer'});
      logger.level = 'debug';

      const testContracts = {
        assetHolder: {
          // TODO: Replace with GRTAssetHolder contract
          address: process.env.ETH_ASSET_HOLDER_ADDRESS || constants.AddressZero
        },
        attestationApp: {
          address: process.env.ATTESTATION_APP || constants.AddressZero
        }
      } as NetworkContracts;

      const receiptManager = new ReceiptManager(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logger.child({module: 'ReceiptManager'}) as any,
        RECEIPT_PRIVATE_KEY,
        testContracts,
        {
          ...overwriteConfigWithDatabaseConnection(defaultTestConfig, {dbName: 'receipt'}),
          ethereumPrivateKey: ETHERLIME_ACCOUNTS[1].privateKey,
          networkConfiguration: {
            ...defaultTestConfig.networkConfiguration,
            rpcEndpoint: process.env.RPC_ENDPOINT
          }
        }
      );

      const attestations = await generateAttestations(args.numAllocations);
      await receiptManager.migrateWalletDB();
      const start = () => startApp(receiptManager, attestations, logger, args.port);
      args.cluster
        ? throng({
            start,
            // We only use half of the cores, assuming that the remainder will be used for the payer server.
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
  receiptManager: ReceiptManager,
  attestations: Record<string, {signature: string; responseCID: string}>,
  logger: pino.Logger,
  port: number
) {
  express()
    .use(bodyParser.json({limit: '5mb'}))
    .post('/payment', async (req, res) => {
      logger.trace('call made to /payment', req);
      const {privateKey, payment} = req.body;

      const {responseCID, signature} = attestations[privateKey];

      const messages = await receiptManager.provideAttestation(payment, {
        responseCID,
        signature
      });
      logger.trace('provideAttestation response', messages);
      res.send(messages);
    })
    .post('/messages', async (req, res) => {
      const messages = await receiptManager.inputStateChannelMessage(req.body);
      logger.trace('inputStateChannelMessage response', messages);
      res.send(messages);
    })
    .get('/', (_, res) => res.status(200).send('Ready to roll!'))
    .listen(port, () => logger.info('Listening for requests', {url: RECEIPT_SERVER_URL}));
}
