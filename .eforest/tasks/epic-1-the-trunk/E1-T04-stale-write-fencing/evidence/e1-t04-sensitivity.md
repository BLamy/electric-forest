# E1-T04 sensitivity

Sabotage: replaced the registered stream-fs validator registry with an isolated registry that has no fencing validator.
stale full write status=201 EXPECTED-FAIL OK
The stale-refusal measurement turns red (the sabotaged door accepts the stale action), proving the committed refusal assertions are sensitive to the fence.
