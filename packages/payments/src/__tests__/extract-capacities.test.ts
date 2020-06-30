import {fixture} from '@graphprotocol/statechannels-contracts/lib/test/fixture';
import {ChannelRequest, EnsureAllocationRequest} from '../channel-manager';
import {extractCapacity} from '../utils';
import {TEST_ALLOCATION} from './crash-test-dummies';

type WithCapacities = {currentCapacities: Record<string, number | undefined>};

const allocation = TEST_ALLOCATION;
const request = fixture<EnsureAllocationRequest>({allocation, type: 'SetTo', num: 10});
const channelRequest = fixture<ChannelRequest>({allocation, capacity: 10});
const currentCapacities: Record<string, number | undefined> = {[allocation.id]: 10};

type GoodCase = {
  request: EnsureAllocationRequest;
  channelRequest: ChannelRequest;
  maxCapacity: number;
};
function testGoodCase(_case: Partial<GoodCase>) {
  const t: GoodCase & WithCapacities = {
    currentCapacities,
    request: request(),
    channelRequest: channelRequest(),
    maxCapacity: 100,
    ..._case
  };

  expect(extractCapacity(t.currentCapacities, t.maxCapacity)(t.request)).toMatchObject(
    t.channelRequest
  );
}

// prettier-ignore
const goodCases: Partial<GoodCase>[] = [
  {request: request({type: 'SetTo', num: 20}), channelRequest: channelRequest({capacity: 20})},
  {request: request({type: 'SetTo', num: 11}), channelRequest: channelRequest({capacity: 11})},
  {request: request({type: 'SetTo', num: 9}), channelRequest: channelRequest({capacity: 10})},
  {request: request({type: 'SetTo', num: 101}), channelRequest: channelRequest({capacity: 100})},
  {request: request({type: 'SetTo', num: 50}), channelRequest: channelRequest({capacity: 25}), maxCapacity: 25},
  {request: request({allocation: {id: 'some other id'}}), channelRequest: channelRequest({allocation: {id: 'some other id'}})},
  {request: request({type: 'IncreaseBy'}), channelRequest: channelRequest({capacity: 20})},
  {request: request({type: 'IncreaseBy', num: 25}), channelRequest: channelRequest({capacity: 35})},
  {request: request({type: 'ScaleBy', num: 1})},
  {request: request({type: 'ScaleBy', num: 1.2}), channelRequest: channelRequest({capacity: 12})},
  {request: request({type: 'ScaleBy', num: 1.00001})},
  {request: request({type: 'ScaleBy', num: 3}), channelRequest: channelRequest({capacity: 30})}
];
it.each(goodCases)('extractCapacities works: %#', testGoodCase);

type Type = 'ScaleBy' | 'SetTo' | 'IncreaseBy';
type BadCase = {
  request: EnsureAllocationRequest;
  reason: string;
  types: Type[];
  currentCapacities: Record<string, number | undefined>;
  maxCapacity: number;
};
// prettier-ignore
const badCases: (Partial<BadCase> & {reason: string})[] = [
  {reason: 'num must be positive', request: request({num: -1}), types: ['SetTo', 'ScaleBy', 'IncreaseBy']},
  {reason: 'num must be positive', request: request({num: 0}), types: ['SetTo', 'ScaleBy', 'IncreaseBy']},
  {reason: 'num must be an integer', request: request({num: 0.5}), types: ['IncreaseBy', 'SetTo']},
  {reason: 'scaling factor must be at least 1', request: request({num: 0.8}), types: ['ScaleBy']},
  {reason: 'current capacity must be positive', request: request({num: 1.2}), types: ['ScaleBy'], currentCapacities: {[allocation.id]: 0}}
];

function testBadCase(_case: Partial<BadCase> & {reason: string}) {
  const t: BadCase & WithCapacities = {
    currentCapacities,
    request: request(),
    types: ['SetTo'],
    maxCapacity: 100,
    ..._case
  };

  t.types.map((type) => {
    expect(() =>
      extractCapacity(t.currentCapacities, t.maxCapacity)({...t.request, type})
    ).toThrowError(t.reason);
  });
}

it.each(badCases)('extractCapacities failure mode: %#', testBadCase);
