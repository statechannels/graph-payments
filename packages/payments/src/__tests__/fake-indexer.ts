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
import {Wallet} from 'ethers';
import {Logger} from '@graphprotocol/common-ts';
import {Allocation, QueryExecutionResult} from '../query-engine-types';
import {isLedgerChannel} from '../utils';
import {buildTestAllocation} from './crash-test-dummies';
import {toAttestationProvided} from '@graphprotocol/statechannels-contracts';
import {getTestAttestation} from '../../../e2e-testing/src/utils';

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
  private blocks: Block[] = [];

  constructor({privateKey, logger}: FakeIndexerParams) {
    const wallet = privateKey ? new Wallet(privateKey) : Wallet.createRandom();
    this.logger = logger && logger.child({name: `fake-indexer-${wallet.address.substr(0, 6)}`});
    this.privateKey = wallet.privateKey;
    this.address = wallet.address;
    this.logger?.debug(`Fake indexer address: ${this.address}`);
  }

  async pushMessage(message: WireMessage): Promise<WireMessage> {
    this.logger?.debug('pushMessage', message);

    const payload = await this._pushPayload(message.data);

    await this.delayIfBlocking();

    return Promise.resolve({recipient: '', sender: '', data: payload});
  }

  async pushPayload(payload: unknown): Promise<WirePayload> {
    const result = this._pushPayload(payload);

    await this.delayIfBlocking();

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
      if (wireState.isFinal || wireState.turnNum === 0) {
        this.logger?.debug(
          `Received and signing state ${wireState.turnNum} from channel ${wireState.channelNonce}`
        );
        // sign and return
        return this.signState({...incTurnNum(wireState), signatures: []});
      } else if (wireState.turnNum === 2) {
        this.logger?.debug(
          `Received a postfund state ${wireState.turnNum} from channel ${wireState.channelNonce}`
        );
        // sign and return
        return this.signState({...incTurnNum(wireState), signatures: []});
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
        const {allocations, appData} = toAttestationProvided(
          prevAppData,
          prevAllocations,
          attestation.responseCID,
          attestation.signature
        );
        const newOutcome = serializeOutcome(deserializeAllocations(allocations));

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
