# Description
**Title** Clear, single line description of the pull request, written as though it was an order.

Then, following a single blank line, a summary of the change and which issue is fixed, including 
- [ ] what is the problem being solved
- [ ] why this is a good approach
- [ ] what are the shortcomings of this approach, if any
It may include
- [ ] background information, such as "Fixes #"
- [ ] benchmark results
- [ ] links to design documents
- [ ] dependencies required for this change

The summary may omit some of these details if this PR fixes a single ticket that includes these details. It is the reviewer's discretion. 

## [Optional] Changes
Multiple changes are not recommended, so this section should normally be omitted. Unforunately, they are sometimes unavoidable. If there are multiple logical changes, list them separately.

1. `'foo'` is replaced by `'bar'`
2. `'fizzbuzz'` is optimized for gas

# [Optional] How Has This Been Tested?

Did you need to run manual tests to verify this change? If so, please describe the tests that you ran to verify your changes. Provide instructions so we can reproduce. Please also list any relevant details for your test configuration

# [Optional] :warn: Does this require multiple approvals?
Please explain which reason, if any, why this requires more than one approval.
- [ ] Is it security related?
- [ ] Is it a significant process change?
- [ ] Is it a significant change to architectural, design?

# Checklist:

## Code quality
- [ ] I have written clear commit messages
- [ ] I have performed a self-review of my own code
- [ ] I have scoped this change as narrowly as possible
- [ ] I have separated logic changes from refactor changes (formatting, renames, etc.)
- [ ] I have commented my code wherever necessary
- [ ] I have added tests that prove my fix is effective or that my feature works
## Project management
- [ ] I have applied the [appropriate labels](https://github.com/statechannels/statechannels/issues/3177)
- [ ] I have linked to relevant issues
- [ ] I have added dependent tickets
- [ ] I have assigned myself to this PR
- [ ] I have chosen the appropriate pipeline