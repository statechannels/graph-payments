/* eslint-disable @typescript-eslint/no-explicit-any */
/** To run the unit tests:
 *  1. Install and run postgres.
 *  2. Run 'createdb receipt-manager'
 */
process.env.SERVER_DB_NAME = 'receipt_manager';

import * as fs from 'fs';

import {SignedState, Payload} from '@statechannels/wallet-core';
import {Message as WireMessage} from '@statechannels/client-api-schema';
import {toJS} from '@graphprotocol/statechannels-contracts';
import {
  defaultTestConfig,
  overwriteConfigWithDatabaseConnection,
  DBAdmin
} from '@statechannels/server-wallet';

import {ReceiptManager} from '../receipt-manager';
import {
  mockCreatedChannelMessage,
  mockCreatedZeroChannelMessage,
  mockQueryRequestMessage,
  mockSCAttestation,
  mockAppData,
  mockPostFundMessage,
  mockCloseChannelMessage,
  mockContracts
} from '../__mocks__/receipt-manager.mocks';

import {createTestLogger} from './setup';

const LOG_FILE = '/tmp/receipt-manager-test.log';
// const LOG_FILE = undefined // turn off logging

const logger = createTestLogger(LOG_FILE).child({name: 'receipt-manager'});
logger.level = 'debug';

let receiptManager: ReceiptManager;
let indexerAddress: string;
const RECEIPT_MANAGER_CONNECTION = {database: 'receipt_manager_test'};
function stateFromPayload(payload: WireMessage['data'] | undefined, index = 0): SignedState {
  expect(payload).toBeDefined();
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return (payload as Payload).signedStates![index];
}
const walletConfig = overwriteConfigWithDatabaseConnection(
  defaultTestConfig(),
  RECEIPT_MANAGER_CONNECTION
);
beforeAll(async () => {
  await DBAdmin.migrateDatabase(walletConfig);
  await DBAdmin.truncateDatabase(walletConfig);
  receiptManager = await ReceiptManager.create(
    logger,
    '0x95942b296854c97024ca3145abef8930bf329501b718c0f66d57dba596ff1318',
    mockContracts,
    walletConfig
  );
  LOG_FILE && fs.existsSync(LOG_FILE) && fs.truncateSync(LOG_FILE);
});

beforeEach(async () => {
  logger.info(`Truncating ${process.env.SERVER_DB_NAME}`);
  await DBAdmin.truncateDatabase(walletConfig);
  indexerAddress = await receiptManager.signingAddress();
});

afterAll(async () => {
  await receiptManager.closeDBConnections();
});

describe('ReceiptManager', () => {
  it('can call joinChannel and auto-sign funding state with non-zero allocations channel', async () => {
    const outbound = await receiptManager.inputStateChannelMessage(
      mockCreatedChannelMessage(await receiptManager.signingAddress()).data
    );

    const state1 = stateFromPayload(outbound, 0);
    expect(state1).toMatchObject({turnNum: 0});

    // Fake funding triggers it to also sign turnNum 3
    const state2 = stateFromPayload(outbound, 1);
    expect(state2).toMatchObject({turnNum: 3});
  });

  it('can call joinChannel and auto-sign funding state with zero allocations channel', async () => {
    const outbound = await receiptManager.inputStateChannelMessage(
      mockCreatedZeroChannelMessage(indexerAddress).data
    );

    const state1 = stateFromPayload(outbound, 0);
    expect(state1).toMatchObject({turnNum: 0});

    // Fake funding triggers it to also sign turnNum 3
    const state2 = stateFromPayload(outbound, 1);
    expect(state2).toMatchObject({turnNum: 3});
  });

  it('can validate a payment', async () => {
    await receiptManager.inputStateChannelMessage(mockPostFundMessage(indexerAddress).data);
    await expect(
      receiptManager.inputStateChannelMessage(mockQueryRequestMessage(indexerAddress).data)
    ).resolves.not.toThrow();
  });

  it('can provide attestation response', async () => {
    await receiptManager.inputStateChannelMessage(mockCreatedChannelMessage(indexerAddress).data);
    await receiptManager.inputStateChannelMessage(mockPostFundMessage(indexerAddress).data);

    const attestationMessage = await receiptManager.provideAttestation(
      mockQueryRequestMessage(indexerAddress).data,
      mockSCAttestation()
    );

    const nextState = stateFromPayload(attestationMessage);
    const appData = toJS(nextState.appData);
    expect(appData.constants).toEqual(mockAppData().constants);
    expect(appData.variable.responseCID).toEqual(mockSCAttestation().responseCID);

    expect((nextState.outcome as any)[0].allocationItems.map((i: any) => i.amount)).toEqual([
      '0x0000000000000000000000000000000000000000000000000000000000000063', //BN.from(99),
      '0x0000000000000000000000000000000000000000000000000000000000000001' //BN.from(1),
    ]);
  });

  it('denies queries for stale channels received by sync channel', async () => {
    await receiptManager.inputStateChannelMessage(mockCreatedChannelMessage(indexerAddress).data);
    await receiptManager.inputStateChannelMessage(mockPostFundMessage(indexerAddress).data);

    const outbound = await receiptManager.declineQuery(
      mockQueryRequestMessage(indexerAddress).data
    );
    const nextState = stateFromPayload(outbound);
    const appData = toJS(nextState.appData);
    expect(appData.constants).toEqual(mockAppData().constants);

    expect(nextState).toMatchObject({turnNum: 5});
  });

  it('can deny a query', async () => {
    await receiptManager.inputStateChannelMessage(mockCreatedChannelMessage(indexerAddress).data);
    await receiptManager.inputStateChannelMessage(mockPostFundMessage(indexerAddress).data);

    const outbound = await receiptManager.declineQuery(
      mockQueryRequestMessage(indexerAddress).data
    );

    const nextState = stateFromPayload(outbound);
    const appData = toJS(nextState.appData);
    expect(appData.constants).toEqual(mockAppData().constants);

    expect(nextState).toMatchObject({turnNum: 5});
  });

  it('can accept a channel closure', async () => {
    await receiptManager.inputStateChannelMessage(mockCreatedChannelMessage(indexerAddress).data);
    await receiptManager.inputStateChannelMessage(mockPostFundMessage(indexerAddress).data);
    const outbound = await receiptManager.inputStateChannelMessage(
      mockCloseChannelMessage(indexerAddress).data
    );

    const nextState = stateFromPayload(outbound);
    expect(nextState).toMatchObject({turnNum: 4, isFinal: true});
  });
});
