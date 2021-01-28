import * as fs from 'fs';

import _, {range} from 'lodash';
import {scriptName} from 'yargs';

/*
Simple utility to generate a geometric random variable, a non-negative integer with mean 1/p.
*/
function geometricRandomInt(p: number): number {
  let n = 1;
  while (Math.random() > p) n++;

  return n;
}

type FundingTestConfig = {
  removalRate: number;
  avgNumToAdd: number;
  numEpochs: number;
  epochInterval: number;
  initialCapacity: number;
};

// Since we can deterministically generated the allocations, this
// data lets us reproduce the current state with less data stored on disk.
type CompressedSyncAllocationData = {
  numAdded: number;
  // Indices of the currently active allocations
  active: Set<number>;
  timestamp: number;
};

function generateNextSyncAllocationData(
  current: CompressedSyncAllocationData,
  config: FundingTestConfig
) {
  const next = _.cloneDeep(current);

  // Remove about config.removalRate of the active allocations
  range(0, current.numAdded)
    .filter(() => Math.random() <= config.removalRate)
    .map((idx) => next.active.delete(idx));

  // Add some new ones
  next.numAdded += geometricRandomInt(1 / config.avgNumToAdd);

  _.range(current.numAdded, next.numAdded).map((idx) => next.active.add(idx));

  next.timestamp += config.epochInterval;

  return next;
}

export type SyncAllocationEvent = Omit<CompressedSyncAllocationData, 'active'> & {
  active: Array<number>;
  type: 'syncAllocations';
};

const toStored = ({active, ...rest}: CompressedSyncAllocationData): SyncAllocationEvent => ({
  ...rest,
  active: Array.from(active),
  type: 'syncAllocations'
});

/*
Generate the first pass of load generation, mimicking period calls to `syncAllocations` with
mostly-overlapping allocations
*/
function firstPass(config: FundingTestConfig): CompressedSyncAllocationData[] {
  // This is the steady state average
  const startWith = Math.floor(config.avgNumToAdd / config.removalRate);

  let current = {numAdded: startWith, active: new Set<number>(_.range(startWith)), timestamp: 0};

  const events = [current];
  _.range(config.numEpochs - 1).map(() => {
    current = generateNextSyncAllocationData(current, config);
    events.push(current);
  });

  return events;
}

export type StoredTestData = {
  events: SyncAllocationEvent[];
  config: FundingTestConfig;
};

// GENERATION

const {
  avgNumToAdd,
  removalRate,
  numEpochs,
  epochInterval,
  initialCapacity
}: FundingTestConfig = scriptName('generate-management-load')
  .option('avgNumToAdd', {type: 'number', default: 10})
  .option('removalRate', {type: 'number', default: 0.3})
  .option('numEpochs', {type: 'number', default: 3})
  .option('epochInterval', {type: 'number', default: 60_000})
  .option('initialCapacity', {type: 'number', default: 60}).argv;

const config: FundingTestConfig = {
  avgNumToAdd,
  removalRate,
  numEpochs,
  epochInterval,
  initialCapacity
};

function generateAndStoreTestData() {
  const events = firstPass(config);

  const testData: StoredTestData = {
    config,
    events: events.map(toStored)
  };

  fs.mkdirSync('data');
  fs.writeFileSync('data/events.json', JSON.stringify(testData));

  // Log some data to help with prototyping.
  const numActive = events.map((e) => e.active.size);
  const avgActive = numActive.reduce((a, b) => a + b) / config.numEpochs;
  console.log('Using config %o', config);
  console.log('Active allocations per epoch:', numActive);
  console.log('Average # active allocations per epoch: %s', avgActive);
}

// With pre-cached allocations, takes about 2s to generate 1_000 epochs, 100 new allocations per epoch
// Without pre-cached allocations, virtually all time is spent generating allocations ...
console.time('Generating test data takes');
generateAndStoreTestData();
console.timeEnd('Generating test data takes');
