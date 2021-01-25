import {utils, Wallet, constants} from 'ethers';
import {
  makeDestination,
  BN,
  serializeState,
  createSignatureEntry,
  State as InternalState,
  calculateChannelId,
  makeAddress
} from '@statechannels/wallet-core';
import {AppData, fromJS, toAddress} from '@graphprotocol/statechannels-contracts';
import {SignedState as WireState, Message as WireMessage} from '@statechannels/wire-format';
import {NetworkContracts} from '@graphprotocol/common-ts';

const ALLOCATION_ID = toAddress('0xB035Dc8Be2560359659Fe34C34DbBA3FC52Ba4Bb');

export const mockSCAttestation = (): {responseCID: string; signature: string} => ({
  responseCID: constants.HashZero,
  signature: utils.joinSignature({r: constants.HashZero, s: constants.HashZero, v: 0})
});

const sampleAttestation = mockSCAttestation();
export const mockAppData = (): AppData => ({
  constants: {
    chainId: 0,
    verifyingContract: constants.AddressZero,
    subgraphDeploymentID: constants.HashZero,
    maxAllocationItems: 2
  },
  variable: {
    ...sampleAttestation,
    allocationId: ALLOCATION_ID,
    requestCID: constants.HashZero,
    paymentAmount: BN.from(1),
    signature: '0x'
  }
});

const MOCK_GATEWAY = {
  wallet: Wallet.createRandom()
};

interface MockStateParams {
  indexerAddress: string;
  gatewayBal?: number;
  turnNum?: number;
  isFinal?: boolean;
}

export const mockContracts = {
  assetHolder: {address: constants.AddressZero},
  attestationApp: {address: '0x0000000000000000000000000000000000111121' /* nonzero */}
} as NetworkContracts;

const mockState = ({
  indexerAddress,
  gatewayBal,
  turnNum,
  isFinal
}: MockStateParams): InternalState => ({
  channelNonce: 0,
  chainId: '0',
  appDefinition: makeAddress('0x0000000000000000000000000000000000111121' /* nonzero */),
  appData: fromJS(mockAppData()),
  participants: [
    {
      participantId: 'gateway',
      destination: makeDestination(MOCK_GATEWAY.wallet.address),
      signingAddress: makeAddress(MOCK_GATEWAY.wallet.address)
    },
    {
      participantId: 'me',
      destination: makeDestination(indexerAddress),
      signingAddress: makeAddress(indexerAddress)
    }
  ],
  turnNum: turnNum || 0,
  isFinal: !!isFinal,
  challengeDuration: 0,
  outcome: {
    type: 'SimpleAllocation',
    assetHolderAddress: makeAddress(constants.AddressZero),
    allocationItems: [
      {
        amount: BN.from(gatewayBal ?? 100),
        destination: makeDestination(MOCK_GATEWAY.wallet.address)
      },
      {
        amount: BN.from(0),
        destination: makeDestination(ALLOCATION_ID)
      }
    ]
  }
});

export const mockCreatedChannelMessage = (
  indexerAddress: string,
  gatewayBal = 100
): WireMessage => {
  const state = mockState({indexerAddress, gatewayBal});
  const targetChannelId = calculateChannelId(state);
  return {
    sender: 'gateway',
    recipient: 'me',
    data: {
      walletVersion: 'mock',
      signedStates: [signAsGateway(state)],
      objectives: [
        {
          type: 'OpenChannel',
          data: {
            fundingStrategy: 'Fake',
            targetChannelId
          },
          participants: state.participants
        }
      ]
    }
  };
};

export const mockCreatedZeroChannelMessage = (indexerAddress: string): WireMessage =>
  mockCreatedChannelMessage(indexerAddress, 0);

export const mockPostFundMessage = (indexerAddress: string, gatewayBal = 100): WireMessage => ({
  sender: 'gateway',
  recipient: 'me',
  data: {
    walletVersion: 'mock',
    signedStates: [signAsGateway(mockState({indexerAddress, gatewayBal, turnNum: 3}))]
  }
});

export const mockQueryRequestMessage = (indexerAddress: string): WireMessage => ({
  sender: 'gateway',
  recipient: 'me',
  data: {
    walletVersion: 'mock',
    signedStates: [signAsGateway(mockState({indexerAddress, turnNum: 4}))]
  }
});

export const mockCloseChannelMessage = (indexerAddress: string): WireMessage => {
  const state = mockState({indexerAddress, turnNum: 4, isFinal: true});
  const targetChannelId = calculateChannelId(state);
  return {
    sender: 'gateway',
    recipient: 'me',
    data: {
      walletVersion: 'mock',
      signedStates: [signAsGateway(state)],
      objectives: [
        {
          type: 'CloseChannel',
          data: {
            fundingStrategy: 'Direct',
            targetChannelId
          },
          participants: state.participants
        }
      ]
    }
  };
};

const signAsGateway = (state: InternalState): WireState =>
  serializeState({
    ...state,
    signatures: [createSignatureEntry(state, MOCK_GATEWAY.wallet.privateKey)]
  });
