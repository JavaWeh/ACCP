package main

// Authorization checks are evidence of isolation, not an availability error
// budget. Even one unexpected response must prevent capacity acceptance.
func phaseThresholds(read, write, authorization summary, errorRate, eventP95 float64) bool {
	return read.P95 <= 500 && write.P95 <= 1000 && errorRate < 0.005 && eventP95 <= 5000 && authorization.Count > 0 && authorization.Errors == 0
}
