import {SubgraphDeploymentID} from '@graphprotocol/common-ts';
import {constants, utils} from 'ethers';
import * as base58 from 'bs58';
import {defaultTestConfig} from '@statechannels/server-wallet';
export const RECEIPT_SERVER_PORT = 5198;
export const PAYER_SERVER_PORT = 5199;

export const RECEIPT_SERVER_URL = `http://localhost:${RECEIPT_SERVER_PORT}`;
export const PAYER_SERVER_URL = `http://localhost:${PAYER_SERVER_PORT}`;

export const RECEIPT_SERVER_DB_NAME = 'receipt';
export const PAYER_SERVER_DB_NAME = 'payer';

// 0x333356F625259653A2B6d7Da44162631DCbdF93F
export const RECEIPT_PRIVATE_KEY =
  '0xa69a8d9fde414bdf8b5d76bbff63bd78704fe3da1d938cd10126a9e2e3e0e11f';
//0x11115FAf6f1BF263e81956F0Cc68aEc8426607cf
export const PAYER_PRIVATE_KEY =
  '0x95942b296854c97024ca3145abef8930bf329501b718c0f66d57dba596ff1318';

export const TEST_SUBGRAPH_ID = new SubgraphDeploymentID(
  base58.encode([
    0x12,
    0x20,
    ...utils.arrayify(utils.sha256(Buffer.from('network-subgraph-indexer-1')))
  ])
);

export const REQUEST_CID = utils.hexZeroPad('0x1', 32);
export const RESPONSE_CID = utils.hexZeroPad('0x2', 32);
// We want to use the same chainId that we use in the payment manager/ receipt manager
export const CHAIN_ID = process.env.CHAIN_ID
  ? parseInt(process.env.CHAIN_ID)
  : defaultTestConfig().networkConfiguration.chainNetworkID;

export const VERIFYING_CONTRACT = constants.AddressZero;

export const TEST_GRAPHQL_RESPONSE = 'OK';

export const TEST_ATTESTATION_APP_ADDRESS = '0x0000000000000000000000000000000000111121';
