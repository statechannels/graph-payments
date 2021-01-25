import {createPaymentServer, createReceiptServer} from '../src/external-server';
import {PAYER_SERVER_URL, RECEIPT_SERVER_DB_NAME, PAYER_SERVER_DB_NAME} from '../src/constants';
import {clearExistingChannels, createTestLogger, generateAllocationIdAndKeys} from '../src/utils';
import * as fs from 'fs';
import autocannon from 'autocannon';

import {configureEnvVariables} from '@statechannels/devtools';
import {Logger} from '@graphprotocol/common-ts';

jest.setTimeout(180_000);
configureEnvVariables();
const STRESS_TEST_DURATION = '1m';
const STRESS_TEST_WARM_UP_DURATION = '10s';
const STRESS_TEST_CONNECTIONS = 50;
const LOG_FILE = '/tmp/stress-test.log';
const logFileArg = `--logFile ${LOG_FILE}`;

const fundingArg = `--fundingStrategy ${process.env.FUNDING_STRATEGY || 'Fake'}`;
const threadingArg = `--amountOfWorkerThreads ${process.env.AMOUNT_OF_WORKER_THREADS || 6}`;
const serverArgs = [logFileArg, fundingArg, threadingArg];
const paymentServer = createPaymentServer(serverArgs.concat(['-c 100', '--numAllocations 1']));
const receiptServer = createReceiptServer(serverArgs);
let logger: Logger;

describe('stress test', () => {
  beforeAll(async () => {
    LOG_FILE && fs.existsSync(LOG_FILE) && fs.truncateSync(LOG_FILE);
    logger = createTestLogger(LOG_FILE);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (logger as any).level = 'debug';

    await Promise.all([RECEIPT_SERVER_DB_NAME, PAYER_SERVER_DB_NAME].map(clearExistingChannels));
    await Promise.all([paymentServer.start(logger), receiptServer.start(logger)]);
  });

  afterAll(async () => {
    await Promise.all([paymentServer.stop(), receiptServer.stop()]);
  });

  test('Payment Manager and Receipt Manager work together', async () => {
    const {privateKey, allocationId} = generateAllocationIdAndKeys(1)[0];
    const warmUpResults = await autocannon({
      url: `${PAYER_SERVER_URL}/sendPayment?privateKey=${privateKey}&allocationId=${allocationId}`,
      connections: STRESS_TEST_CONNECTIONS,
      duration: STRESS_TEST_WARM_UP_DURATION
    });

    expect(warmUpResults.non2xx).toBe(0);

    const results = await autocannon({
      url: `${PAYER_SERVER_URL}/sendPayment?privateKey=${privateKey}&allocationId=${allocationId}`,
      connections: STRESS_TEST_CONNECTIONS,
      duration: STRESS_TEST_DURATION
    });

    console.log(JSON.stringify(results, null, 1));
    logger.info('Stress test results', {results});

    expect(results.non2xx).toBe(0);
    expect(results.errors).toBe(0);
  });
});
