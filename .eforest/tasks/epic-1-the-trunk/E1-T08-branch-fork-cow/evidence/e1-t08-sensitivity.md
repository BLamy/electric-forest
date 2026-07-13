# E1-T08 sensitivity proof
- golden byte mutation: EXPECTED-FAIL (status=0 digestChanged=true)
- resolver includes parent events above fork: EXPECTED-FAIL exit=2
- branch writes reuse parent content stream: EXPECTED-FAIL exit=2
- cross-boundary patch skips frozen parent resolution: EXPECTED-FAIL exit=2
- emit-log includes fork directive: EXPECTED-FAIL exit=2
