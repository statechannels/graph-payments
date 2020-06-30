import {createPaymentServer, createReceiptServer} from '../src/external-server';
import {PAYER_SERVER_URL, RECEIPT_SERVER_DB_NAME, PAYER_SERVER_DB_NAME} from '../src/constants';
import {clearExistingChannels, createTestLogger, generateAllocationIdAndKeys} from '../src/utils';
import * as fs from 'fs';
import autocannon from 'autocannon';

import {Logger} from 'pino';

jest.setTimeout(180_000);
const STRESS_TEST_DURATION = '1m';
const STRESS_TEST_WARM_UP_DURATION = '10s';
const STRESS_TEST_CONNECTIONS = 50;
const LOG_FILE = '/tmp/stress-test.log';
const logToFileOpts = [`--logFile ${LOG_FILE}`];
const paymentServer = createPaymentServer(logToFileOpts.concat(['-c 100']));
const receiptServer = createReceiptServer(logToFileOpts);
let logger: Logger;

describe('stress test', () => {
  beforeAll(async () => {
    LOG_FILE && fs.existsSync(LOG_FILE) && fs.truncateSync(LOG_FILE);
    logger = createTestLogger(LOG_FILE);
    logger.level = 'debug';

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
