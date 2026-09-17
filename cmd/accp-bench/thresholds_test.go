package main

import "testing"

func TestAuthorizationFailureCannotHideInsideErrorBudget(t *testing.T) {
	read, write := summary{Count: 42000, P95: 100}, summary{Count: 12000, P95: 200}
	authorization := summary{Count: 6000}
	if !phaseThresholds(read, write, authorization, 0.001, 300) {
		t.Fatal("ordinary request failures below the agreed budget should pass")
	}
	authorization.Errors = 1
	if phaseThresholds(read, write, authorization, 1.0/60000, 300) {
		t.Fatal("one authorization failure was hidden inside the availability budget")
	}
	if phaseThresholds(read, write, summary{}, 0, 300) {
		t.Fatal("missing isolation evidence was accepted")
	}
	authorization.Errors = 0
	if phaseThresholds(read, write, authorization, 0.005, 300) {
		t.Fatal("the error-rate threshold must remain strictly below 0.5 percent")
	}
}
