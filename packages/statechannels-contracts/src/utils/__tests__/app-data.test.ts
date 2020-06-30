import {abiEncoder, pureJSEncoder, abiDecoder, pureJSDecoder} from '../app-data';
import {attestationProvided, queryDeclined, queryRequested, startState} from './fake-app-data';

function testEncodeDecode(toJS, fromJS) {
  it.each`
    name                      | state
    ${'start state'}          | ${startState}
    ${'query requestsed'}     | ${queryRequested}
    ${'attestation provided'} | ${attestationProvided}
    ${'query declined'}       | ${queryDeclined}
  `('it works for $name', ({state}) => {
    expect(toJS(fromJS(state))).toEqual(state);
  });
}

describe('abi decoder / abi encoder', () => {
  testEncodeDecode(abiDecoder, abiEncoder);
});

describe('abi decoder / pure js encoder', () => {
  testEncodeDecode(abiDecoder, pureJSEncoder);
});

describe('pure js decoder / abi encoder', () => {
  testEncodeDecode(pureJSDecoder, abiEncoder);
});

describe(' pure js decoder / pure js encoder', () => {
  testEncodeDecode(pureJSDecoder, pureJSEncoder);
});

describe('abi encoding vs non-abi encoding', () => {
  it('works', () => {
    expect(pureJSEncoder(startState)).toEqual(abiEncoder(startState));
    expect(pureJSEncoder(queryRequested)).toEqual(abiEncoder(queryRequested));
    expect(pureJSEncoder(attestationProvided)).toEqual(abiEncoder(attestationProvided));
    expect(pureJSEncoder(queryDeclined)).toEqual(abiEncoder(queryDeclined));
  });
});

describe('abi decoding vs non-abi decoding', () => {
  it('works', () => {
    const encoded = abiEncoder(startState);
    expect(abiDecoder(encoded)).toEqual(pureJSDecoder(encoded));
  });
});
