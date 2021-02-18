/* eslint-disable @typescript-eslint/no-explicit-any */
import express from 'express';
import bodyParser from 'body-parser';
import {ReceiptManager} from '@graphprotocol/receipts';
import {Argv, scriptName} from 'yargs';
import throng from 'throng';
import {
  defaultTestConfig,
  overwriteConfigWithDatabaseConnection
} from '@statechannels/server-wallet';
import {ETHERLIME_ACCOUNTS} from '@statechannels/devtools';
import {constants} from 'ethers';
import {Logger, NetworkContracts} from '@graphprotocol/common-ts';

import {createTestLogger, generateAttestations} from './utils';
import {
  RECEIPT_PRIVATE_KEY,
  RECEIPT_SERVER_PORT,
  RECEIPT_SERVER_URL,
  TEST_ATTESTATION_APP_ADDRESS
} from './constants';

const builder = (yargs: Argv): Argv =>
  yargs
    .option('ensureAllocations', {type: 'boolean', default: true})
    .alias('e', 'ensureAllocations')
    .option('port', {type: 'number', default: RECEIPT_SERVER_PORT})
    .alias('p', 'port')
    .boolean('cluster')
    .option('logFile', {type: 'string', required: true})
    .alias('l', 'logFile')
    .option('numAllocations', {type: 'number', default: 1})
    .option('pgUsername', {type: 'string', default: 'postgres'})
    .alias('u', 'pgUsername')
    .option('pgDatabase', {type: 'string', default: 'receipt'})
    .alias('d', 'pgDatabase');

type AnyArgs = {[key: string]: any} & Argv['argv'];

const commands = {
  listen: {
    command: 'listen',
    describe: 'Start a receipt manager, and start listening to the `/sendPayment` endpoint',
    builder,
    handler: async (args: AnyArgs): Promise<void> => {
      const logger = createTestLogger(args.logFile).child({module: 'ReceiptServer'});
      (logger as any).level = 'trace';

      const testContracts = {
        assetHolder: {
          // TODO: Replace with GRTAssetHolder contract
          address: process.env.ETH_ASSET_HOLDER_ADDRESS || constants.AddressZero
        },
        attestationApp: {
          address: process.env.ATTESTATION_APP || TEST_ATTESTATION_APP_ADDRESS
        }
      } as NetworkContracts;

      const config = {
        ...overwriteConfigWithDatabaseConnection(defaultTestConfig(), {
          database: args.pgDatabase,
          user: args.pgUsername,
          host: 'localhost'
        }),
        chainServiceConfiguration: {
          attachChainService: !!process.env.RPC_ENDPOINT,
          provider: process.env.RPC_ENDPOINT,
          pk: ETHERLIME_ACCOUNTS[1].privateKey
        },
        loggingConfiguration: {
          logDestination: args.logFile,
          logLevel: 'trace'
        }
      } as const;

      const receiptManager = await ReceiptManager.create(
        logger.child({module: 'ReceiptManager'}) as any,
        RECEIPT_PRIVATE_KEY,
        testContracts,
        config
      );

      const attestations = await generateAttestations(args.numAllocations);

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
  logger: Logger,
  port: number
) {
  express()
    .use(bodyParser.json({limit: '5mb'}))
    .post('/payment', async (req, res) => {
      req.setTimeout(3_600_000); // One hour
      logger.trace('call made to /payment', req);
      const {privateKey, payment} = req.body;

      const {responseCID, signature} = attestations[privateKey];

      const messages = await receiptManager.provideAttestation(payment, {
        responseCID,
        signature
      });
      logger.trace('provideAttestation response', messages as any);
      res.send(messages);
    })
    .post('/messages', async (req, res) => {
      const messages = await receiptManager.inputStateChannelMessage(req.body);
      logger.trace('inputStateChannelMessage response', messages as any);
      res.send(messages);
    })
    .get('/', (_, res) => res.status(200).send('Ready to roll!'))
    .listen(port, () => logger.info('Listening for requests', {url: RECEIPT_SERVER_URL}));
}
