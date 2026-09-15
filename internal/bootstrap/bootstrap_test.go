package bootstrap

import "testing"

func TestHumanBootstrapRequiresCompleteProjectOwnership(t *testing.T) {
	if err := Validate(DevelopmentSpec()); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*Spec){
		func(s *Spec) { s.Humans = nil },
		func(s *Spec) { s.Humans[0].Memberships[0].Roles = []string{"MEMBER"} },
		func(s *Spec) { s.Humans[0].Memberships[0].Roles = []string{"AGENT"} },
		func(s *Spec) { s.Humans[1].Memberships[0].ProjectID = "project_unknown" },
		func(s *Spec) { s.Humans[1].ID = s.Humans[0].ID },
	} {
		spec := DevelopmentSpec()
		change(&spec)
		if Validate(spec) == nil {
			t.Fatal("incomplete or invalid human mapping accepted")
		}
	}
}
