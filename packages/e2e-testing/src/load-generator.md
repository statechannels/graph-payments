# Problem

The gateway periodically calls `syncAllocations` with an overlapping set of allocations
eg.

- `syncAllocations([{id: 1}, {id: 2}, {id: 3}, {id: 4}])`
  is later followed with
- `syncAllocations([{id: 2}, {id: 4}, {id: 5}, {id: 6}])`
  - cause ledger 1 & 3 to close
  - no effect on ledger 2 & 4
  - create ledger 5 & 6

This happens many times successively, with the first call overloading the channel manager. In addition, messages may be delivered in a random order, or not at all.

The differences between our e2e test setup lead to issues in production that seemingly did not arise until a large number of channels were created.
A strategy is described below to generate load that's more similar to the production load, letting us be more confident in the funding protocol from end to end.

# Sample event timeline

cap = capacity

We want to trigger a sequence of calls like the following:

1.

```
syncAllocations([
  { id: 1, cap: 5},
  { id: 2, cap: 5},
  { id: 3, cap: 5},
])
```

2.

```
syncAllocations([
  { id: 1, cap: 5},
  { id: 2, cap: 5},
  { id: 3, cap: 5},
  { id: 4, cap: 5},
  { id: 5, cap: 5},
])
```

(in relatively quick succession)

3. `ensureAllocations([{id: 1, cap: 10}])`
4. `ensureAllocations([{id: 1, cap: 20}])`
5. `ensureAllocations([{id: 2, cap: 10}])`
6. `ensureAllocations([{id: 1, cap: 40}])`
7.

```
syncAllocations([
  { id: 1, cap: 40},
  { id: 4, cap: 5},
  { id: 5, cap: 5},
  { id: 6, cap: 5},
  { id: 7, cap: 5},
])
```

(in relatively quick succession)

8. `ensureAllocations([{id: 8, cap: 5}])`
9. `ensureAllocations([{id: 5, cap: 10}])`
10. `ensureAllocations([{id: 6, cap: 10}])`

## Assertions

At this point, we should observe

- two closed ledger channels (for ids 2, 3)
- 15 closed payment channels (10 for 2, 5 for 3)
- 6 open, funded ledger channels (for ids 1, 4, 5, 6, 7, 8)
- 80 open, ledger funded payment channels

Later, we will add some payments to the list of events.

# Strategy

## Event generation

We generate a random sequence of events in three passes

### First pass

In the first pass, generate the `syncAllocations` calls

Keep track of the indices of which allocations are currently active, and how many have been added so far

```
{
  type: 'sync',
  scheduleAt: 0,
  numAdded: 5,
  active: [],
}
```

Given a (deterministic) array of allocations, which we can generate with a specific mnemonic, we can compute the input data to `syncAllocations`
Schedule explicit additions and deletions to occur in lockstep every 2 minutes, eg. generating

1.

```
{
  type: 'sync',
  scheduleAt: 120,
  numAdded: 7,
  active: [2,3,5,6,7],
}
```

2.

```
{
  type: 'sync',
  scheduleAt: 240,
  numAdded: 10,
  removed: [2,3,6,8,9,10],
}
```

These will be randomly generated. Eg.

- remove each active allocation with a fixed probability q
- generate a geometric(p) number of new allocations to activate

(the steady-state average number of active allocations in this case is q/p)

### Second pass

Generate some `ensureAllocations` calls for each allocation, and weave them into the timeline, while those allocations are active.

```
[
  { method: 'ensure', id: 7, scaleBy: 1.2, scheduleAt: 33},
  { method: 'ensure', id: 3, scaleBy: 1.1, scheduleAt: 52},
  { method: 'ensure', id: 1, scaleBy: 1.7, scheduleAt: 97},
  { method: 'ensure', id: 6, scaleBy: 1.5, scheduleAt: 123}
]
```

### Third pass

- Filter out `ensure` method calls for inactive allocations.
- (?) Filter out `ensure` method calls when the capacity is already above some threshold

## Execution

One option for execution is `rxjs`:

```
import {range, of} from 'rxjs';
import {concatMap, delay} from 'rxjs/operators';

// const randomDelays = _.range(10).map(() => 1000 + Math.random() * 4000);

// Generated by copying randomDelays above into a nodejs console
const deterministicDelays = [
  4790.083040734984,
  3410.9453150112454,
  1461.8904391826745,
  2320.085443086703,
  4907.445765801889,
  4986.838015319262,
  1597.4369701554883,
  3749.2029497420426,
  3178.333764248645,
  4179.20204976131
];

let then = Date.now();

range(1, 3)
  // copied from SO
  .pipe(concatMap((i) => of(i).pipe(delay(deterministicDelays[i] / 10))))
  .subscribe(
    (val) => {
      // this prints
      // 346 341.09453150112454
      // 152 146.18904391826745
      // 236 232.0085443086703
      console.log(Date.now() - then, deterministicDelays[val] / 10);
      then = Date.now();

      // We can, for instnace, trigger a syncAllocation call here
    },
    console.error,
    process.exit
  );
```

If we _expect_ concurrent calls to `syncChannels`, rather than _sequential_ calls (which the above timeline would give) then we can instead do something much simpler:

```
events.map(event => setTimeout(triggerEvent(event), event.timeStamp));
```

## Assertions

At the end, we can assert that

- allocations in `activeAllocations` have the corrrect number of open channels
- allocations in `removedAllocations` have no open channels, and the corrrect number of closed channels

## Repeatability

We're effectively generating json-RPC input that should be sent at scheduled times.
This means we can write the input & schedule to a file, and repeat the same test.
This is will hopefully make it easier to debug issues.

(Note that test input doesn't necessarily guarantee deterministic test runs. There is a lot of asynchronous code at play.)