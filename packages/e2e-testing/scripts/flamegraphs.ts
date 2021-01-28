/* eslint-disable @typescript-eslint/no-explicit-any */
import {execSync} from 'child_process';
import * as fs from 'fs';

import rimraf from 'rimraf';
import autocannon from 'autocannon';

import {
  createFlameGraphReceiptServer,
  createFlameGraphPaymentServer,
  createReceiptServer,
  createPaymentServer
} from '../src/external-server';
import {clearExistingChannels, createTestLogger} from '../src/utils';
import {RECEIPT_SERVER_DB_NAME, PAYER_SERVER_DB_NAME, PAYER_SERVER_URL} from '../src/constants';

(async () => {
  // Synchronously delete the clinic folder
  rimraf.sync('.clinic');
  execSync('yarn build');
  const LOG_FILE = '/tmp/flamegraph.log';
  fs.existsSync(LOG_FILE) && fs.truncateSync(LOG_FILE);
  const logger = createTestLogger(LOG_FILE);
  (logger as any).level = 'debug';
  const logToFileOpts = [`--logFile ${LOG_FILE}`];

  await clearExistingChannels(RECEIPT_SERVER_DB_NAME);
  await clearExistingChannels(PAYER_SERVER_DB_NAME);
  const setupReceiptServer = createReceiptServer(logToFileOpts);
  const setupPaymentServer = createPaymentServer(
    logToFileOpts.concat(['-c 10', '--ensureAllocations true'])
  );

  await setupReceiptServer.start(logger);
  await setupPaymentServer.start(logger);
  await setupPaymentServer.stop();
  await setupReceiptServer.stop();

  const receiptServer = createFlameGraphReceiptServer(logToFileOpts);
  const paymentServer = createFlameGraphPaymentServer(
    logToFileOpts.concat(['-c 10', '--ensureAllocations false'])
  );
  const servers = [receiptServer, paymentServer];

  await Promise.all(servers.map((s) => s.start(logger)));

  await autocannon({
    url: `${PAYER_SERVER_URL}/sendPayment`,
    connections: 50,
    duration: '1m'
  });
  console.log('stopping servers');
  await Promise.all(servers.map((s) => s.stop('SIGINT')));

  console.log('servers stopped');
  process.exit(0);
})();
