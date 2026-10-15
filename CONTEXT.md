# Legacy Billing Automation

A platform that turns invoice creation in billing software without an API into a callable API, by running structured Workflows against that software's UI.

## Language

### Parties

**Tenant**:
A business the Engine serves (e.g. Sharma Traders), which owns Target Instances and Runs.
_Avoid_: Customer (that is an invoice Parameter), client, account, organisation

**Client App**:
A program that calls the Engine's API to start Runs on behalf of a Tenant.
_Avoid_: Caller, consumer, integration

### Workflows

**Workflow**:
A named business task in a Target App (e.g. `create-invoice` for Tally) that Client Apps call by name. Its content lives in Workflow Versions.
_Avoid_: Script, bot, recipe, playbook

**Workflow Version**:
One frozen snapshot of a Workflow: its Steps, Target Map, Parameters, Outputs and Commit Step. Either Draft or Published.
_Avoid_: Revision, release

**Draft**:
A Workflow Version proposed from a Demonstration that a person has not yet approved. Cannot be run.
_Avoid_: Pending workflow, candidate

**Published**:
A Workflow Version a person has reviewed and approved. Frozen; changes produce a new Draft. Runs use the latest Published version.
_Avoid_: Live, active

**Step**:
One entry in a Workflow Version: an Action applied to a Target, optionally with a value.
_Avoid_: Instruction, command

**Action**:
The verb of a Step, chosen from a fixed approved set (`fill`, `click`, `read`, `verify`). Anything outside the set is rejected.
_Avoid_: Operation, op

**Target**:
A logical name for a UI element or screen state in the Target App (e.g. `customer`, `save`, `invoice-created`), independent of how it is located on screen.
_Avoid_: Selector, element, locator

**Target Map**:
The lookup, belonging to one Workflow Version, that ties each Target name to how it is found in the Target App's UI. Learned from a Demonstration.
_Avoid_: Selector map, locator file

**Parameter**:
A `{{placeholder}}` in a Step's value, filled from the Client App's input at run time. Has a type (`string`, `number` or `date`) and is either required or optional.
_Avoid_: Variable, slot

**Output**:
A named value a `read` Step captures from the Target App during a Run (e.g. `invoice_number`) and returns to the Client App.
_Avoid_: Result, return value, extract

**Workflow Contract**:
The API request and response shape of a Workflow Version, derived entirely from its Parameters and Outputs.
_Avoid_: Schema, interface, spec

**Commit Step**:
The single Step in a Workflow Version after which the business effect (e.g. a saved invoice) may exist in the Target App. Marked by a person during approval.
_Avoid_: Save point, point of no return

### Learning

**Demonstration**:
A recording of a person performing a task once by hand in the Target App, from which a Draft is proposed.
_Avoid_: Recording, session, trace

### Execution

**Engine**:
The whole platform being built: it learns Workflows from Demonstrations, lets a person approve them, exposes them as an API, and runs them against Target Instances.
_Avoid_: Platform, system, bot

**Learner**:
The part of the Engine that turns a Demonstration into a Draft.
_Avoid_: Recorder, compiler, trainer

**Executor**:
The part of the Engine that validates a Run's input and replays a Published Workflow Version's Steps against a Target Instance.
_Avoid_: Runner, player, interpreter

**Agent**:
A program installed inside a Tenant's network that connects out to the Engine, pulls Runs for its Target Instances and executes them locally.
_Avoid_: Robot, connector, bot, worker

**Run**:
One execution of a Published Workflow Version against one Target Instance, triggered by a Client App with concrete Parameter values.
_Avoid_: Job, execution, invocation

**Run Step**:
The record of one Step within a Run: the value used, the outcome, timing and any screenshot.
_Avoid_: Step log, trace entry

**Run Status**:
The outcome of a Run: `succeeded`; `failed` (stopped before the Commit Step, nothing created, safe to retry); or `needs_review` (stopped at or after the Commit Step, outcome uncertain, a person must check).
_Avoid_: State, result

### Target Apps

**Target App**:
A billing software product (e.g. one specific legacy package). Workflows are learned once per Target App. In the MVP, a demo application standing in for real legacy software.
_Avoid_: Legacy system, host app

**Target Instance**:
One Tenant's own running installation of a Target App, which Runs are executed against.
_Avoid_: Installation, deployment, site, tenant app

**Concurrency Limit**:
The maximum number of Runs a Target Instance can handle at the same time, set by its sessions or licences (often 1). It is never exceeded.
_Avoid_: Rate limit, capacity, seats
