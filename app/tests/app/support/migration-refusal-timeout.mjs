// TEST ONLY: prove that a printed refusal plus unchanged rows cannot turn SIGKILL into PASS.
// This is a harness control, never an application migration or a simulated gate result.
console.error('Flux migration footprint refused: TEST ONLY timeout control');
setInterval(() => {}, 1000);
