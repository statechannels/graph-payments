import benny from 'benny';
import {abiDecoder, abiEncoder, pureJSDecoder, pureJSEncoder} from '../app-data';
import {attestationProvided} from './fake-app-data';

benny.suite(
  'State encoding',

  benny.add('encode (abi encoder)', () => {
    abiEncoder(attestationProvided);
  }),

  benny.add('encode (pure js)', () => {
    pureJSEncoder(attestationProvided);
  }),

  benny.cycle(),
  benny.complete()
);

const encoded = abiEncoder(attestationProvided);

benny.suite(
  'State decoding',

  benny.add('decode (abi encoder)', () => {
    abiDecoder(encoded);
  }),

  benny.add('decode (pure js)', () => {
    pureJSDecoder(encoded);
  }),

  benny.cycle(),
  benny.complete()
);
