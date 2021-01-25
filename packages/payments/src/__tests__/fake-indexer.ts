/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  serializeState,
  deserializeState,
  deserializeOutcome,
  serializeAllocation,
  SimpleAllocation,
  serializeOutcome,
  deserializeAllocations,
  createSignatureEntry
} from '@statechannels/wallet-core';
import pMap from 'p-map';
import {validatePayload} from '@statechannels/wallet-core';
import {
  SignedState as WireState,
  Payload as WirePayload,
  Message as WireMessage
} from '@statechannels/wire-format';
import {BigNumber, constants, utils, Wallet} from 'ethers';
import {Logger, SubgraphDeploymentID} from '@graphprotocol/common-ts';
import {Allocation, QueryExecutionResult} from '../query-engine-types';
import {isLedgerChannel} from '../utils';
import {buildTestAllocation} from './crash-test-dummies';
import {signAttestation, toAttestationProvided} from '@graphprotocol/statechannels-contracts';
import {defaultTestConfig} from '@statechannels/server-wallet';
import base58 from 'bs58';

const RECEIPT_PRIVATE_KEY = '0xa69a8d9fde414bdf8b5d76bbff63bd78704fe3da1d938cd10126a9e2e3e0e11f';

const TEST_SUBGRAPH_ID = new SubgraphDeploymentID(
  base58.encode([
    0x12,
    0x20,
    ...utils.arrayify(utils.sha256(Buffer.from('network-subgraph-indexer-1')))
  ])
);

const REQUEST_CID = utils.hexZeroPad('0x1', 32);
const RESPONSE_CID = utils.hexZeroPad('0x2', 32);
// We want to use the same chainId that we use in the payment manager/ receipt manager
const CHAIN_ID = BigNumber.from(defaultTestConfig().networkConfiguration.chainNetworkID).toNumber();
const VERIFYING_CONTRACT = constants.AddressZero;

const getTestAttestation = async (
  privateKey = RECEIPT_PRIVATE_KEY
): Promise<{responseCID: string; signature: string}> => {
  const signature = await signAttestation(
    privateKey,
    REQUEST_CID,
    RESPONSE_CID,
    TEST_SUBGRAPH_ID.toString(),
    CHAIN_ID,
    VERIFYING_CONTRACT
  );

  return {
    responseCID: RESPONSE_CID,
    signature
  };
};

interface FakeIndexerParams {
  privateKey?: string;
  logger?: Logger;
}

// Receives messages and responds with the appropriate 'next' state
export class FakeIndexer {
  private privateKey: string;
  private logger?: Logger;
  public address: string;
  private blocking = false;
  private online = true;
  private blocks: Block[] = [];

  constructor({privateKey, logger}: FakeIndexerParams) {
    const wallet = privateKey ? new Wallet(privateKey) : Wallet.createRandom();
    this.logger = logger && logger.child({name: `fake-indexer-${wallet.address.substr(0, 6)}`});
    this.privateKey = wallet.privateKey;
    this.address = wallet.address;
    this.logger?.debug(`Fake indexer address: ${this.address}`);
  }

  private async modifyBehaviour(): Promise<void> {
    await this.delayIfBlocking();
    this.throwIfOffline();
  }

  async pushMessage(message: WireMessage): Promise<WireMessage> {
    this.logger?.debug('pushMessage', message);

    const payload = await this._pushPayload(message.data);

    await this.modifyBehaviour();

    return Promise.resolve({recipient: '', sender: '', data: payload});
  }

  async pushPayload(payload: unknown): Promise<WirePayload> {
    const result = this._pushPayload(payload);

    await this.modifyBehaviour();

    return Promise.resolve(result);
  }

  async pushQuery(
    message: WireMessage
  ): Promise<{response: WireMessage; result: QueryExecutionResult}> {
    const response = await this.pushMessage(message);

    return {response, result: {} as QueryExecutionResult};
  }

  private async _pushPayload(rawPayload: unknown): Promise<WirePayload> {
    const payload = validatePayload(rawPayload);

    if (payload.signedStates === undefined) {
      throw new Error(`Fake indexer currently only supports payloads with some signed states.`);
    }

    const handleState = async (wireState: WireState): Promise<WireState | undefined> => {
      // if conclude, propose, postFundSetup
      if (wireState.turnNum === 0) {
        this.logger?.debug(
          `Received and signing state ${wireState.turnNum} from channel ${wireState.channelNonce}`
        );
        // sign and return
        return this.signState(wireState);
      } else if (wireState.isFinal) {
        this.logger?.debug(
          `Received and signing isFinal state ${wireState.turnNum} from channel ${wireState.channelNonce}`
        );
        // sign and return
        return this.signState({...incTurnNum(wireState), signatures: []});
      } else if (wireState.turnNum === 3) {
        this.logger?.debug(
          `Received a postfund state ${wireState.turnNum} from channel ${wireState.channelNonce}`
        );
        // sign and return
        return this.signState(wireState);
      } else if (wireState.turnNum >= 3 && isLedgerChannel(wireState)) {
        this.logger?.debug(`Received a ledger update for ${wireState.channelId}`);

        // sign and return
        return this.signState(wireState);
      } else if (wireState.turnNum % wireState.participants.length === 0) {
        this.logger?.debug(
          `Received and advancing state ${wireState.turnNum} from channel ${wireState.channelNonce}`
        );

        const {appData: prevAppData, outcome} = wireState;
        const prevAllocations = serializeAllocation(
          deserializeOutcome(outcome) as SimpleAllocation
        );

        const attestation = await getTestAttestation();
        const {allocation, appData} = toAttestationProvided(
          prevAppData,
          prevAllocations[0],
          attestation.responseCID,
          attestation.signature
        );
        const newOutcome = serializeOutcome(deserializeAllocations([allocation]));

        return this.signState({
          ...incTurnNum(wireState),
          outcome: newOutcome,
          appData,
          signatures: []
        });
      }
    };

    // Some responses may be undefined e.g., when SyncChannel requests come in
    function notUndefined<T>(x: T | undefined): x is T {
      return x !== undefined;
    }

    return {
      walletVersion: 'mock',
      signedStates: (await pMap(payload.signedStates, handleState)).filter(notUndefined)
    };
  }

  allocation(allocationId: string): Allocation {
    return buildTestAllocation(this.address, allocationId);
  }

  private signState(wireState: WireState): WireState {
    const state = deserializeState(wireState);

    const signedState = {
      ...state,
      signatures: [createSignatureEntry(state, this.privateKey)]
    };

    return serializeState(signedState);
  }

  public goOffline(): void {
    this.logger?.debug(`FakeIndexer offline`);
    this.online = false;
  }

  public goOnline(): void {
    this.logger?.debug(`FakeIndexer online`);
    this.online = true;
  }

  private throwIfOffline() {
    if (!this.online) throw new Error('FakeIndexer is offline');
  }

  public block(): void {
    this.logger?.debug(`FakeIndexer blocked`);
    this.blocking = true;
  }

  private delayIfBlocking(): Promise<void> {
    if (this.blocking) {
      const block = new Block();
      this.blocks.push(block);
      this.logger?.debug(`FakeIndexer blocked a request`, {
        queueLength: this.blocks.length
      });
      return block.promise;
    }
    return Promise.resolve();
  }

  public unblock(): Promise<void[]> {
    this.blocking = false;
    const promises = this.blocks.map((b) => b.promise);
    this.logger?.debug(`FakeIndexer unblocked. Releasing ${this.blocks.length} requests.`);
    this.blocks.forEach((b) => b.resolve());
    this.blocks = [];
    return Promise.all(promises);
  }
}

const incTurnNum = (state: WireState): WireState => {
  return {...state, turnNum: state.turnNum + 1};
};

// https://stackoverflow.com/a/44905352
class Block {
  promise: Promise<void>;
  reject!: () => void;
  resolve!: () => void;

  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.reject = reject;
      this.resolve = resolve;
    });
  }
}
