import {BN} from '@statechannels/wallet-core';
import {ethers} from 'ethers';
const {HashZero} = ethers.constants;

import {AppData, nullState, toAddress} from '../app-data';

export const startState: AppData = {
  constants: {
    chainId: 5,
    allocationId: toAddress('0x1111111111111111111111111111111111111111'),
    verifyingContract: '0x2222222222222222222222222222222222222222',
    subgraphDeploymentID: '0x3333333333333333333333333333333333333333333333333333333333333333'
  },
  variable: {
    paymentAmount: BN.from(0),
    requestCID: HashZero,
    responseCID: HashZero,
    signature: '0x'
  }
};

export const queryRequested: AppData = {
  ...startState,
  variable: {
    ...nullState.variable,

    paymentAmount: BN.from('100000000000000000'),
    requestCID: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  }
};

export const attestationProvided: AppData = {
  ...queryRequested,
  variable: {
    ...queryRequested.variable,

    responseCID: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    signature:
      '0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001c'
  }
};
export const queryDeclined: AppData = {
  ...queryRequested,
  variable: {
    ...queryRequested.variable
  }
};
