// TEST ONLY: prove that a printed refusal plus unchanged rows cannot turn SIGKILL into PASS.
// This is a harness control, never an application migration or a simulated gate result.
import { stderr } from 'node:process';
import { setInterval } from 'node:timers';
stderr.write('Flux migration footprint refused: TEST ONLY timeout control\n');
setInterval(() => undefined, 1000);
